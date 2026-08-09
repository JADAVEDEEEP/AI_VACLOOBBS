const pool = require("../engine/db");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function executeWithRetry(fn, attempts = 2) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      if (attempt < attempts) {
        await sleep(1000);
      }
    }
  }

  throw lastError;
}

async function executeLLM(config, input) {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
  });

  const prompt = `
${config.prompt || "Analyze the following input."}

Input:
${JSON.stringify(input)}
`;

  const result = await model.generateContent(prompt);

  return {
    text: result.response.text(),
  };
}

async function executeHttp(config, input) {
  const response = await fetch(config.url, {
    method: config.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(config.headers || {}),
    },
    ...(config.method !== "GET"
      ? {
          body: JSON.stringify(config.body || input),
        }
      : {}),
  });

  if (!response.ok) {
    throw new Error(`HTTP request failed: ${response.status}`);
  }

  const contentType = response.headers.get("content-type");

  if (contentType?.includes("application/json")) {
    return await response.json();
  }

  return await response.text();
}

async function executeConditional(config, input) {
  const value = input?.[config.field];

  const condition =
    config.operator === "equals"
      ? value === config.value
      : config.operator === "contains"
      ? String(value || "")
          .toLowerCase()
          .includes(String(config.value || "").toLowerCase())
      : false;

  return {
    condition,
    branch: condition ? "true" : "false",
  };
}

async function executeDbWrite(config, input, runId) {
  await pool.query(
    `
    INSERT INTO workflow_data
    (
      org_id,
      workflow_id,
      workflow_run_id,
      key,
      value
    )
    VALUES ($1, $2, $3, $4, $5)
    `,
    [
      config.org_id,
      config.workflow_id,
      runId,
      config.key || "workflow_result",
      JSON.stringify(input),
    ]
  );

  return {
    saved: true,
  };
}

async function executeNotify(config, input) {
  console.log("NOTIFICATION:", {
    message: config.message,
    input,
  });

  return {
    notified: true,
  };
}

async function executeWorkflow(runId, startPosition = 0) {
  const runResult = await pool.query(
    `
    SELECT
      wr.id,
      wr.workflow_id
    FROM workflow_runs wr
    WHERE wr.id = $1
    `,
    [runId]
  );

  if (!runResult.rows.length) {
    throw new Error("Workflow run not found");
  }

  const run = runResult.rows[0];

  const stepsResult = await pool.query(
    `
    SELECT *
    FROM workflow_steps
    WHERE workflow_id = $1
    ORDER BY position ASC
    `,
    [run.workflow_id]
  );

  const steps = stepsResult.rows;

  let previousOutput = null;

  // Resume case: get output from the last completed step
  if (startPosition > 0) {
    const previousStepResult = await pool.query(
      `
      SELECT sr.output
      FROM step_runs sr
      JOIN workflow_steps ws
        ON ws.id = sr.workflow_step_id
      WHERE sr.workflow_run_id = $1
        AND ws.position < $2
        AND sr.status = 'completed'
      ORDER BY ws.position DESC
      LIMIT 1
      `,
      [runId, startPosition]
    );

    if (previousStepResult.rows.length) {
      previousOutput = previousStepResult.rows[0].output;
    }
  }

  for (const step of steps) {
    // Skip already completed steps during resume
    if (step.position < startPosition) {
      continue;
    }

    // Create step run
    const stepRunResult = await pool.query(
      `
      INSERT INTO step_runs
      (
        workflow_run_id,
        workflow_step_id,
        status,
        input,
        attempt_count,
        started_at
      )
      VALUES
      ($1, $2, 'running', $3, 1, NOW())
      RETURNING id
      `,
      [
        runId,
        step.id,
        JSON.stringify(previousOutput),
      ]
    );

    const stepRunId = stepRunResult.rows[0].id;

    try {
      let output;

      // LLM
      if (step.type === "llm_call") {
        output = await executeWithRetry(
          () => executeLLM(step.config, previousOutput),
          2
        );
      }

      // HTTP
      else if (step.type === "http_request") {
        output = await executeWithRetry(
          () => executeHttp(step.config, previousOutput),
          2
        );
      }

      // CONDITIONAL
      else if (step.type === "conditional_branch") {
        output = await executeConditional(
          step.config,
          previousOutput
        );
      }

      // DB WRITE
      else if (step.type === "db_write") {
        output = await executeDbWrite(
          {
            ...step.config,
            org_id: step.config.org_id,
            workflow_id: run.workflow_id,
          },
          previousOutput,
          runId
        );
      }

      // NOTIFY
      else if (step.type === "notify") {
        output = await executeNotify(
          step.config,
          previousOutput
        );
      }

      // APPROVAL GATE
      else if (step.type === "approval_gate") {
        await pool.query(
          `
          UPDATE step_runs
          SET status = 'paused'
          WHERE id = $1
          `,
          [stepRunId]
        );

        await pool.query(
          `
          UPDATE workflow_runs
          SET status = 'paused'
          WHERE id = $1
          `,
          [runId]
        );

        console.log(
          `Workflow ${runId} paused for approval`
        );

        return {
          status: "paused",
          runId,
          stepRunId,
          position: step.position,
        };
      }

      else {
        throw new Error(
          `Unsupported step type: ${step.type}`
        );
      }

      // Save successful step
      await pool.query(
        `
        UPDATE step_runs
        SET
          status = 'completed',
          output = $1,
          completed_at = NOW()
        WHERE id = $2
        `,
        [
          JSON.stringify(output),
          stepRunId,
        ]
      );

      previousOutput = output;
    } catch (error) {
      console.error(
        `Step ${step.id} failed:`,
        error.message
      );

      await pool.query(
        `
        UPDATE step_runs
        SET
          status = 'failed',
          error = $1,
          completed_at = NOW()
        WHERE id = $2
        `,
        [error.message, stepRunId]
      );

      await pool.query(
        `
        UPDATE workflow_runs
        SET
          status = 'failed',
          error = $1,
          completed_at = NOW()
        WHERE id = $2
        `,
        [error.message, runId]
      );

      throw error;
    }
  }

  // Workflow completed
  await pool.query(
    `
    UPDATE workflow_runs
    SET
      status = 'completed',
      completed_at = NOW()
    WHERE id = $1
    `,
    [runId]
  );

  return {
    status: "completed",
    runId,
  };
}

module.exports = executeWorkflow;