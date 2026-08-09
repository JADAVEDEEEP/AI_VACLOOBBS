const pool = require("../engine/db");
const executeWorkflow = require("../actions/triggerWorkflowRun");

const triggerWorkflowRun = async (req, res) => {
  try {
    // Hasura Action normally sends arguments inside req.body.input
    const input = req.body?.input || req.body || {};

    const workflow_id = input.workflow_id;

    if (!workflow_id) {
      return res.status(400).json({
        success: false,
        message: "workflow_id is required",
      });
    }

    // Get user from Hasura session variables
    const userId =
      req.body?.session_variables?.["x-hasura-user-id"] ||
      req.headers["x-user-id"];

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User authentication required",
      });
    }

    // 1. Get workflow + organization
    const workflowResult = await pool.query(
      `
      SELECT
        w.id,
        w.org_id,
        w.name
      FROM workflows w
      WHERE w.id = $1
      `,
      [workflow_id]
    );

    if (workflowResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Workflow not found",
      });
    }

    const workflow = workflowResult.rows[0];

    // 2. Check organization membership
    const memberResult = await pool.query(
      `
      SELECT role
      FROM org_members
      WHERE org_id = $1
        AND user_id = $2
      `,
      [workflow.org_id, userId]
    );

    if (memberResult.rows.length === 0) {
      return res.status(403).json({
        success: false,
        message: "You are not a member of this organization",
      });
    }

    const role = memberResult.rows[0].role;

    // 3. Only owner/editor can trigger
    if (!["owner", "editor"].includes(role)) {
      return res.status(403).json({
        success: false,
        message: "Only owner/editor can trigger workflow",
      });
    }

    // 4. Check quota
    const orgResult = await pool.query(
      `
      SELECT
        quota_used,
        quota_allowed
      FROM organizations
      WHERE id = $1
      `,
      [workflow.org_id]
    );

    if (orgResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Organization not found",
      });
    }

    const organization = orgResult.rows[0];

    if (
      organization.quota_used >=
      organization.quota_allowed
    ) {
      return res.status(403).json({
        success: false,
        message: "Organization quota exhausted",
      });
    }

    // 5. Create workflow run
    const runResult = await pool.query(
      `
      INSERT INTO workflow_runs
      (
        workflow_id,
        status,
        triggered_by,
        trigger_type,
        started_at
      )
      VALUES
      ($1, 'running', $2, 'manual', NOW())
      RETURNING *
      `,
      [workflow_id, userId]
    );

    const run = runResult.rows[0];

    // 6. Start workflow engine
    // Do not wait here so the Action can immediately return
    executeWorkflow(run.id)
      .then(async (result) => {
        console.log(
          `Workflow ${run.id} finished with status: ${result.status}`
        );

        // Increment quota only after successful completion
        if (result.status === "completed") {
          await pool.query(
            `
            UPDATE organizations
            SET quota_used = quota_used + 1
            WHERE id = $1
            `,
            [workflow.org_id]
          );
        }
      })
      .catch((error) => {
        console.error(
          `Workflow ${run.id} execution failed:`,
          error.message
        );
      });

    // 7. Immediately return run information
    return res.status(201).json({
      success: true,
      message: "Workflow run started",
      run_id: run.id,
      status: "running",
    });

  } catch (error) {
    console.error(
      "Trigger workflow error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to trigger workflow",
    });
  }
};

module.exports = triggerWorkflowRun;