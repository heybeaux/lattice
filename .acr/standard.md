# Lattice

**Purpose:** Governance faculty. Defines policy for when agent actions should be paused for approval (gates) via `getGateStatus(event)` callbacks. Typically reads from `StateContract.approval_gate`. The gate mechanism (the actual veto in Sonder's emit pipeline) lives in Sonder; Lattice decides *when* and *what* to gate. Lattice is also where coordination contracts between agents live.
**Repo:** https://github.com/heybeaux/lattice
**Status:** active
**Phase:** post-fencing-arch lock (2026-05-14); CI matrix on Node 20/22/24
**Last verified:** 2026-05-18

## Runtime

- **Local path:** /Users/beauxwalton/Dev/lattice (verify locally)
- **Tech:** TypeScript, pnpm workspace
- **Build:** `pnpm install && pnpm build`
- **CI:** GitHub Actions, matrix Node 20/22/24, pnpm 10 via `pnpm/action-setup@v4`
- **Adapter shape:** registers with Sonder runtime; implements `getGateStatus(event)` returning pending/clear

## Dependencies

- **Depends on:** Sonder (consumes the `checkGate` hook)
- **Used by:** Ginnung (renders gate UI), Inos (gates on decision nodes), AWM (partners on intent-driven gating)
- **External:** none load-bearing

## Key contacts

- **Owner:** @beauxwalton
- **Recent contributors:** @beauxwalton

## Quick gotchas

- **pnpm 10 only.** Lockfile is v9.0, CI pins pnpm 10. pnpm 8 silently downgrades → CI fails with `ERR_PNPM_LOCKFILE_BREAKING_CHANGE`.
- **mise + corepack shims fight pnpm 10.** `/tmp/pnpm10` may report 8.15.6 even though the standalone binary is v10.4.0. Use a fresh alt path (`/tmp/pnpm10-real`) to bypass.
- **No `packageManager` field in root package.json** as of last check — fix when porting hotfixes.
- **Gate policy belongs here, not in Sonder.** Don't propose moving `getGateStatus` into the Sonder adapter base.

## Where to learn more

- `deep.md` — gate policy contracts, state contract schema
- Memory: `lattice-pnpm10.md`, `ginnung-fencing-architecture.md`
