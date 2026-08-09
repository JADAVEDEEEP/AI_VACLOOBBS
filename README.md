# AI Agent Workflow Builder

A backend service for an AI workflow builder assignment. It supports organization-scoped workflow runs, role checks, workflow step execution, approval gates, and PostgreSQL-backed run tracking.

## Tech Stack

- Node.js
- Express
- PostgreSQL
- Gemini API via `@google/generative-ai`
- `pg` for database access
- `dotenv` for local environment variables

## Project Structure

```text
ai-agent-workflow-builder/
  actions/
    approveStep.js
    triggerWorkflowRun.js
    workflowEngine.js
  engine/
    db.js
  server.js
  package.json
  .env.example
```

## Environment Variables

Create a local `.env` file from `.env.example`:

```bash
cp .env.example .env
```

Then fill in:

```env
PORT=5000
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DATABASE
GEMINI_API_KEY=your_gemini_api_key_here
```

Important: `.env` is intentionally ignored by Git. Do not commit API keys, database URLs, or secrets.

If `.env` was already added to Git before this `.gitignore` existed, remove it from Git tracking with:

```bash
git rm --cached .env
```

## Install

```bash
npm install
```

## Run Locally

```bash
npm start
```

The backend starts on:

```text
http://localhost:5000
```

Health check:

```text
GET /health
```

## Implemented Backend Flow

The backend currently contains handlers for:

- Triggering a workflow run with organization membership and role checks.
- Executing workflow steps in order.
- Calling an LLM step with Gemini.
- Calling generic HTTP request steps.
- Running conditional branch logic.
- Writing workflow output to the database.
- Logging notify steps.
- Pausing a workflow at an approval gate.
- Approving a paused step and resuming the workflow.

## Supported Step Types

- `llm_call`
- `http_request`
- `conditional_branch`
- `db_write`
- `notify`
- `approval_gate`

## Permission Model

The backend uses two permission layers:

1. Organization and role scoping:
   - `owner` and `editor` can trigger workflow runs.
   - `viewer` cannot trigger runs.
   - Users must belong to the workflow's organization.

2. Approval gate enforcement:
   - A paused approval step can only be approved by an `owner` or `editor` in the same organization.
   - This check is done in the action handler before the workflow resumes.

## Assignment Notes

The full assignment expects Nhost, Hasura metadata/migrations, GraphQL operations, subscriptions, frontend workflow builder UI, and at least one non-manual trigger. This repository currently contains the backend workflow execution layer. Add Hasura metadata, migrations, frontend, and deployed app details before final submission.

## GitHub Safety Checklist

Before pushing:

```bash
git status
```

Make sure `.env` is not listed. The repo should include `.env.example`, not `.env`.
