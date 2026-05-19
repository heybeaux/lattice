# Lattice

Governance faculty in the heybeaux stack. Coordination infrastructure for multi-agent systems. Owns gate **policy** (when an agent action should pause for approval) and state contracts. Sonder owns the gate **mechanism** (the pre-emit `checkGate` hook). Three-layer split: Sonder mechanism / Lattice+AWM policy / Ginnung surface.

**Provides:** governance-faculty, gate-policy, state-contracts
**Repo:** https://github.com/heybeaux/lattice
**Relates to:** Sonder hook consumer; Ginnung renders Lattice's gate decisions; partners with AWM on intent-driven gating
