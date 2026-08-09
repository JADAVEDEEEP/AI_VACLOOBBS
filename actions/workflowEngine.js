const pool = require("../engine/db");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

// =====================================================
// LLM
// =====================================================

async function executeLLM(config, input) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
  });

  const prompt = `
${config?.prompt || "Analyze the following input."}

Input:
${JSON.stringify(input ?? null)}
`;

  const result = await model.generateContent(prompt);

  return {
    text: result.response.text(),
  };
}

// =====================================================
// HTTP REQUEST
// =====================================================

async function executeHttp(config, input) {
  if (!config?.url) {
    throw new Error("HTTP step requires a URL");
  }

  const method = (config.method || "GET").toUpperCase();

  const response = await fetch(config.url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(config.headers || {}),
    },
    ...(method !== "GET" && method !== "HEAD"
      ? {
          body: JSON.stringify(config.body ?? input ?? {}),
        }
      : {}),
  });

  if (!response.ok) {
    throw new Error(
      `HTTP request failed: ${response.status} ${response.statusText}`
    );
  }

  const contentType =
    response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return await response.json();
  }

  return await response.text();
}

// =====================================================
// CONDITIONAL
// =====================================================

async function executeConditional(config, input) {
  const field = config?.field;
  const operator = config?.operator;
  const expectedValue = config?.value;

  if (!field) {
    throw new Error(
      "Conditional step requires a field"
    );
  }

  const value = input?.[field];

  let condition = false;

  if (operator === "equals") {
    condition = value === expectedValue;
  } else if (operator === "contains") {
    condition = String(value ?? "")
      .toLowerCase()
      .includes(
        String(expectedValue ?? "").toLowerCase()
      );
  } else if (operator === "not_equals") {
    condition = value !== expectedValue;
  } else if (operator === "exists") {
    condition = value !== undefined && value !== null;
  } else {
    throw new Error(
      `Unsupported conditional operator: ${operator}`
    );
  }

  return {
    condition,
    branch: condition ? "true" : "false",
    value,
  };
}

// =====================================================
// DATABASE WRITE
// =====================================================

async function executeDbWrite(config, input, runId) {
  if (!config?.org_id) {
    throw new Error(
      "DB write step requires org_id"
    );
  }

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
      JSON.stringify(input ?? null),
    ]
  );

  return {
    saved: true,
  };
}

// =====================================================
// NOTIFICATION
// =====================================================

async function executeNotify(config, input) {
  console.log("NOTIFICATION:", {
    message: config?.message || "",
    input,
  });

  return {
    notified: true,
  };
}

// =====================================================
// MAIN WORKFLOW ENGINE
// =====================================================

async function executeWorkflow(
  runId,
  startPosition = 0
) {
  if (!runId) {
    throw new Error("Workflow run ID is required");
  }

  // ---------------------------------------------------
  // 1. Get workflow run
  // ---------------------------------------------------

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

  if (runResult.rows.length === 0) {
    throw new Error("Workflow run not found");
  }

  const run = runResult.rows[0];

  // ---------------------------------------------------
  // 2. Get workflow steps
  // ---------------------------------------------------

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

  // ---------------------------------------------------
  // 3. Resume support
  // ---------------------------------------------------

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

    if (previousStepResult.rows.length > 0) {
      previousOutput =
        previousStepResult.rows[0].output;
    }
  }

  // ---------------------------------------------------
  // 4. Execute every step
  // ---------------------------------------------------

  for (const step of steps) {
    if (step.position < startPosition) {
      continue;
    }

    // -----------------------------------------------
    // Create step run
    // -----------------------------------------------

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

    const stepRunId =
      stepRunResult.rows[0].id;

    try {
      let output;

      // ---------------------------------------------
      // LLM
      // ---------------------------------------------

      if (step.type === "llm_call") {
        output = await executeWithRetry(
          () =>
            executeLLM(
              step.config || {},
              previousOutput
            ),
          2
        );
      }

      // ---------------------------------------------
      // HTTP
      // ---------------------------------------------

      else if (step.type === "http_request") {
        output = await executeWithRetry(
          () =>
            executeHttp(
              step.config || {},
              previousOutput
            ),
          2
        );
      }

      // ---------------------------------------------
      // CONDITIONAL
      // ---------------------------------------------

      else if (
        step.type === "conditional_branch"
      ) {
        output = await executeConditional(
          step.config || {},
          previousOutput
        );
      }

      // ---------------------------------------------
      // DB WRITE
      // ---------------------------------------------

      else if (step.type === "db_write") {
        output = await executeDbWrite(
          {
            ...(step.config || {}),
            org_id:
              step.config?.org_id,
            workflow_id:
              run.workflow_id,
          },
          previousOutput,
          runId
        );
      }

      // ---------------------------------------------
      // NOTIFY
      // ---------------------------------------------

      else if (step.type === "notify") {
        output = await executeNotify(
          step.config || {},
          previousOutput
        );
      }

      // ---------------------------------------------
      // APPROVAL GATE
      // ---------------------------------------------

      else if (
        step.type === "approval_gate"
      ) {
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

      // ---------------------------------------------
      // Unsupported step
      // ---------------------------------------------

      else {
        throw new Error(
          `Unsupported step type: ${step.type}`
        );
      }

      // ---------------------------------------------
      // Save successful step
      // ---------------------------------------------

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
          JSON.stringify(output ?? null),
          stepRunId,
        ]
      );

      previousOutput = output;
    } catch (error) {
      console.error(
        `Step ${step.id} failed:`,
        error.message
      );

      // ---------------------------------------------
      // Save step failure
      // ---------------------------------------------

      await pool.query(
        `
        UPDATE step_runs
        SET
          status = 'failed',
          error = $1,
          completed_at = NOW()
        WHERE id = $2
        `,
        [
          error.message,
          stepRunId,
        ]
      );

      // ---------------------------------------------
      // Save workflow failure
      // ---------------------------------------------

      await pool.query(
        `
        UPDATE workflow_runs
        SET
          status = 'failed',
          error = $1,
          completed_at = NOW()
        WHERE id = $2
        `,
        [
          error.message,
          runId,
        ]
      );

      throw error;
    }
  }

  // ---------------------------------------------------
  // 5. Workflow completed
  // ---------------------------------------------------

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