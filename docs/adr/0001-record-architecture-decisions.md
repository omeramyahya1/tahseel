# 1. Record architecture decisions

Date: 2026-11-21

## Status

Accepted

## Context

Tahseel is a regulated payments system built by a solo developer. The Central Bank of Sudan (CBoS) will assess documentation, change control and operational maturity, and future team members need to understand why the system is shaped the way it is.

## Decision

We record significant architecture decisions as numbered Markdown files in `docs/adr/`, using the format: Title, Date, Status, Context, Decision, Consequences. ADRs are never edited after acceptance except to change their status; a decision is reversed by a new ADR that supersedes it.

## Consequences

- Decisions and their reasoning are reviewable by auditors and new engineers.
- Adds a small amount of writing to each significant change.
