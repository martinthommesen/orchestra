# Security Policy

## Supported versions

Orchestra is in active development. Security fixes are applied to the **latest
commit on `main`** only. There are no separate long-term-support branches at this
time.

| Version                 | Supported |
| ----------------------- | --------- |
| `main` (latest)         | ✅ Yes    |
| Earlier pinned releases | ❌ No     |

## Reporting a vulnerability

**Do not open a public GitHub Issue for security vulnerabilities.**

Please report security issues privately using
[GitHub Security Advisories](https://github.com/martinthommesen/orchestra/security/advisories/new).
This lets us triage, develop a fix, and coordinate disclosure before the issue is
public.

Include as much detail as you can:

- A clear description of the vulnerability and its potential impact.
- Steps to reproduce or a proof-of-concept (sanitized — no live credentials).
- The version/commit you tested against.
- Any suggested mitigations you have in mind.

We aim to acknowledge receipt within **3 business days** and to provide an initial
assessment within **7 business days**.

## Security posture (v1)

Orchestra v1 targets **trusted, single-tenant environments**. Key points:

- Agents run **unsandboxed** with `--allow-all-tools` — treat a dispatched issue as
  arbitrary code execution by whoever can open issues in the tracked repo.
- The cockpit control plane binds to **loopback only** and requires a per-process
  bearer token; cross-origin requests are rejected.
- Secrets are resolved from the environment at load and are **never** serialized,
  logged, or exposed through the JSON API.
- Two credentials are kept deliberately separate: the tracker API key and the agent
  GitHub token.

Read the full trust model in [`README.md § Security & trust posture`](./README.md).

## Preferred contact

GitHub Security Advisories: <https://github.com/martinthommesen/orchestra/security>
