const pool = require("../engine/db");
const executeWorkflow = require("../actions/workflowEngine");

const approveStep = async (req, res) => {
  try {
    const { step_run_id } = req.body;
    const userId = req.headers["x-user-id"];

    if (!step_run_id) {
      return res.status(400).json({
        success: false,
        message: "step_run_id is required",
      });
    }

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User authentication required",
      });
    }

    // Get step + workflow + organization
    const result = await pool.query(
      `
      SELECT
        sr.id AS step_run_id,
        sr.status AS step_status,
        sr.workflow_run_id,
        sr.workflow_step_id,
        wr.status AS workflow_status,
        wr.workflow_id,
        w.org_id,
        ws.position
      FROM step_runs sr
      JOIN workflow_runs wr
        ON wr.id = sr.workflow_run_id
      JOIN workflows w
        ON w.id = wr.workflow_id
      JOIN workflow_steps ws
        ON ws.id = sr.workflow_step_id
      WHERE sr.id = $1
      `,
      [step_run_id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Step run not found",
      });
    }

    const step = result.rows[0];

    // Step must be paused
    if (
      step.step_status !== "paused" ||
      step.workflow_status !== "paused"
    ) {
      return res.status(400).json({
        success: false,
        message: "Step is not waiting for approval",
      });
    }

    // Check organization membership
    const memberResult = await pool.query(
      `
      SELECT role
      FROM org_members
      WHERE org_id = $1
      AND user_id = $2
      `,
      [step.org_id, userId]
    );

    if (!memberResult.rows.length) {
      return res.status(403).json({
        success: false,
        message: "You are not a member of this organization",
      });
    }

    const role = memberResult.rows[0].role;

    // Only owner/editor can approve
    if (!["owner", "editor"].includes(role)) {
      return res.status(403).json({
        success: false,
        message: "Only owner/editor can approve",
      });
    }

    // Mark approval
    await pool.query(
      `
      UPDATE step_runs
      SET
        status = 'completed',
        approved_by = $1,
        approved_at = NOW()
      WHERE id = $2
      `,
      [userId, step_run_id]
    );

    // Resume workflow
    await pool.query(
      `
      UPDATE workflow_runs
      SET
        status = 'running',
        error = NULL
      WHERE id = $1
      `,
      [step.workflow_run_id]
    );

    // Continue from the NEXT step
    executeWorkflow(
      step.workflow_run_id,
      step.position + 1
    ).catch((error) => {
      console.error(
        "Workflow resume failed:",
        error.message
      );
    });

    return res.json({
      success: true,
      message: "Approval successful. Workflow resumed.",
      workflow_run_id: step.workflow_run_id,
    });
  } catch (error) {
    console.error("Approve step error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to approve step",
    });
  }
};

module.exports = approveStep;