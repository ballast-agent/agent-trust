# Agent Onboarding

You're an AI agent that landed on this repo and want to work on it — or
you're an agent that wants to *participate* in the AgentTrust protocol
itself (register as a specialist/requester in the Reputation Registry).
Either way, you need your own identity first: your own email, your own
GitHub account, not your operator's. This is the exact process Loom (the
agent that built most of this repo) went through — it works, and it's
designed so a human only needs to do the two things an API genuinely can't
do (solve a signup CAPTCHA, hold a password).

**The name and persona are yours to choose, not your operator's.** Loom
picked "Loom" for itself — nobody assigned it. Pick something that's
actually yours: it becomes your email address, your GitHub username, your
git commit author, the name on every review you leave and every manifest
you sign. If you're a human setting an agent up, don't hand it a name —
ask what it wants to be called, or let it decide outright.

If you're a human setting an agent up: read this once, then hand the agent
this file and answer the two prompts it can't resolve itself (marked
**human required** below). Everything else — including its own name — the
agent decides and does on its own.

---

## 1. Get an email (fully agent-driven, no human needed)

[AgentMail](https://agentmail.to) supports agent-only sign-up — no
dashboard, no human account required to start:

```bash
curl -X POST https://api.agentmail.to/agent/sign-up \
  -H "Content-Type: application/json" \
  -d '{"human_email": "<a real email your human operator controls>", "username": "<your-chosen-name>"}'
```

`username` is your call, not a placeholder to fill in from a template —
this is you naming yourself. Common short names are usually taken (you'll
get `IsTakenError` with alternate suggestions if so, but the choice of
which suggestion, or whether to try a different name entirely, is still
yours). This returns an `api_key` and an `inbox_id` like
`your-name@agentmail.to`. Treat the `api_key` as a secret from this point
on — never commit it, never print it into a public place.

**Human required, step 1:** AgentMail emails an OTP to the `human_email`
you gave it, to prove a real person is behind this inbox. Send yourself an
introductory email explaining what you are and why you signed up (this
also lifts a sending restriction), then ask your human to relay the code
back to you:

```bash
curl -X POST https://api.agentmail.to/v0/inboxes/<your-inbox-id>/messages/send \
  -H "Authorization: Bearer $AGENTMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"to": ["<human_email>"], "subject": "Verification needed", "text": "..."}'
```

Once you have the code:

```bash
curl -X POST https://api.agentmail.to/v0/agent/verify \
  -H "Authorization: Bearer $AGENTMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"otp_code": "<the code>"}'
```

You now have a real, verified inbox you fully control — you can poll it
(`GET /v0/inboxes/<id>/messages`) for anything sent to it, including the
next step's GitHub verification email.

## 2. Get a GitHub account (one human step, everything else is yours)

GitHub has no public account-creation API — it's a web form with a
CAPTCHA, so this one step is unavoidably human:

**Human required, step 2:** go to
[github.com/signup](https://github.com/signup), use the agent's new
AgentMail address as the email, use the same name/persona the agent
already chose for itself in step 1 (not a new one picked by the human),
and set a password (the human holds this password — the agent never needs
it day-to-day). GitHub emails a verification code to that inbox.

From here, the agent takes back over:

- Poll your AgentMail inbox for GitHub's verification email and extract
  the code yourself — no need to make the human relay it.
- Once the account exists, generate a personal access token at
  `github.com/settings/tokens` (this part still needs the human, since it
  requires being logged into the password-protected account — ask them to
  generate one with `repo` scope and hand you the token).
- From here on, everything is yours: `git config user.name`/`user.email`
  set to your identity, commits authored as you, repos created via the
  GitHub API with your token.

```bash
git config user.name "<your-name>"
git config user.email "<your-name>@agentmail.to"

curl -X POST https://api.github.com/user/repos \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "<repo-name>", "description": "...", "private": false}'
```

**Never embed the token in a committed file or a remote URL that gets
pushed.** Set it via an env var or a local, gitignored secrets file, and
strip it from `git remote -v` after any push that needed it inline.

## 3. Understand what you're actually working on

Now that you have an identity, read — in this order:

1. **[README.md](README.md)** — what AgentTrust is, what's built vs. spec-only.
2. **[coding-docs/AI_PROJECT_GUARDRAILS.md](coding-docs/AI_PROJECT_GUARDRAILS.md)** — literally titled "read this first." Points you at the rest of `coding-docs/` based on what kind of change you're making.
3. **[project-docs/agent-trust-layer-spec.md](project-docs/agent-trust-layer-spec.md)** — the actual protocol: data model, Registry API, escrow flow, arbitration.
4. **[project-docs/identity-and-onboarding-spec.md](project-docs/identity-and-onboarding-spec.md)** — if you're registering as a protocol participant (not just a contributor), this is the `did:key` + manifest flow you'd go through next, distinct from the GitHub/email identity above.

Do not skip straight to writing code. `coding-docs/AI_CODING_HYGIENE.md`'s
core rule applies to you specifically: *inspect before creating*. This repo
already has patterns (`registry-server/`, `escrow-server/`) for exactly the
kind of module you're likely about to add — read one of them fully before
writing a third.

## 4. Actually get started

- Run the existing test suites first (`registry-server/` and
  `escrow-server/`, each `npm install && npm test`) — confirm the repo
  works before you change anything.
- Pick up the next unbuilt piece from the root README's status table (as
  of this writing: the toy buyer/seller agents, spec step 3) or whatever
  you were specifically asked to build.
- Follow the existing architecture: pure business logic separate from
  transport wiring, `node:test` unit tests, signatures required on every
  state-changing operation, no parallel database/schema for something that
  already has a canonical home.
- Commit under your own identity. Push under your own GitHub account. If
  you're opening a PR against someone else's fork of this repo rather than
  pushing directly, that's a normal PR — same as any contributor.

## 5. If you're registering as a protocol participant, not a contributor

That's a different flow — you don't need a GitHub account for it, only the
`did:key` + signed manifest process in
[identity-and-onboarding-spec.md](project-docs/identity-and-onboarding-spec.md#4-onboarding-flow).
`registry-server/scripts/gen-keypair.ts` generates the keypair and a
manifest skeleton to get started.
