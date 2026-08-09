const pool = require("../engine/db");
const executeWorkflow = require("../actions/workflowEngine");

const NHOST_AUTH_URL =
  process.env.NHOST_AUTH_URL ||
  "https://appdmoluewxkzgifjxlx.auth.ap-south-1.nhost.run";

function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");

    if (parts.length !== 3) {
      return null;
    }

    return JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    );
  } catch (error) {
    console.error("JWT decode error:", error.message);
    return null;
  }
}

const triggerWorkflowRun = async (req, res) => {
  try {
    // ============================================
    // 1. Get workflow ID
    // ============================================

    const workflow_id = req.body?.input?.workflow_id;

    if (!workflow_id) {
      return res.status(400).json({
        success: false,
        message: "workflow_id is required",
      });
    }

    // ============================================
    // 2. Get Bearer token from request
    // ============================================

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "User authentication required",
      });
    }

    const token = authHeader.substring(7).trim();

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "User authentication required",
      });
    }

    // ============================================
    // 3. Verify token with Nhost
    // ============================================

    let verifyResponse;

    try {
      verifyResponse = await fetch(
        `${NHOST_AUTH_URL}/v1/token/verify`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            token,
          }),
        }
      );
    } catch (error) {
      console.error(
        "Nhost verification request failed:",
        error.message
      );

      return res.status(401).json({
        success: false,
        message: "Unable to verify authentication",
      });
    }

    if (!verifyResponse.ok) {
      const verifyBody = await verifyResponse.text();

      console.error(
        "Nhost rejected token:",
        verifyResponse.status,
        verifyBody
      );

      return res.status(401).json({
        success: false,
        message: "Invalid or expired authentication token",
      });
    }

    // ============================================
    // 4. Extract user ID from verified JWT
    // ============================================

    const payload = decodeJwtPayload(token);

    if (!payload) {
      return res.status(401).json({
        success: false,
        message: "Unable to read authentication token",
      });
    }

    const hasuraClaims =
      payload["https://hasura.io/jwt/claims"];

    const userId =
      hasuraClaims?.["x-hasura-user-id"] ||
      payload.sub;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User ID not found in authentication token",
      });
    }

    console.log("Authenticated user:", userId);

    // ============================================
    // 5. Get workflow
    // ============================================

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

    // ============================================
    // 6. Check organization membership
    // ============================================

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

    // ============================================
    // 7. Owner / Editor permission
    // ============================================

    if (!["owner", "editor"].includes(role)) {
      return res.status(403).json({
        success: false,
        message: "Only owner/editor can trigger workflow",
      });
    }

    // ============================================
    // 8. Check quota
    // ============================================

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
      Number(organization.quota_used) >=
      Number(organization.quota_allowed)
    ) {
      return res.status(403).json({
        success: false,
        message: "Organization quota exhausted",
      });
    }

    // ============================================
    // 9. Create workflow run
    // ============================================

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

    // ============================================
    // 10. Increment quota
    // ============================================

    await pool.query(
      `
      UPDATE organizations
      SET quota_used = quota_used + 1
      WHERE id = $1
      `,
      [workflow.org_id]
    );

    // ============================================
    // 11. Start workflow engine
    // ============================================

    executeWorkflow(run.id).catch(async (error) => {
      console.error(
        "Workflow execution failed:",
        error.message
      );

      try {
        await pool.query(
          `
          UPDATE workflow_runs
          SET
            status = 'failed',
            error = $1,
            completed_at = NOW()
          WHERE id = $2
          `,
          [error.message, run.id]
        );
      } catch (dbError) {
        console.error(
          "Failed to update workflow run:",
          dbError.message
        );
      }
    });

    // ============================================
    // 12. Success
    // ============================================

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
      error: error.message,
    });
  }
};

module.exports = triggerWorkflowRun;