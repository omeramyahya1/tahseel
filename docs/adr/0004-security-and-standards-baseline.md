# 4. Security and standards baseline

Date: 2026-11-21

## Status

Accepted

## Context

The CBoS 2014 switch-operator circular names "PCI DSS 2.1" and ISO 8583. It was written for card and ATM switches. Tahseel is an account-to-account gateway built for NIPS, which uses ISO 20022. There is no PCI DSS 2.1: the versions in 2014 were 2.0 and 3.0, and the current one is v4.0.1. PCI DSS governs cardholder data (PANs), which Tahseel doesn't handle.

## Decision

- **PCI DSS v4.0.1 as the security baseline**, with **card data out of scope**. No PAN, track data or CVV ever enters Tahseel systems. When cards arrive, they go through an acquirer's hosted fields. We still apply the controls that matter for a payments system: encryption in transit and at rest, key management, strong access control and MFA, audit logging, network segmentation, secure SDLC, vulnerability management and incident response. The CBoS submission will state the scope explicitly.
- **ISO 20022 as the messaging and domain model.** Payment concepts follow pain.013 (request to pay), pacs.008 (credit transfer) and pacs.002 (status report): creditor and debtor accounts, end-to-end IDs, status reasons.
- **ISO 8583 deferred.** It only becomes relevant if a connector has to talk to a card switch (e.g., SUDAPAN/EBS cards). It would live inside that connector, never in the core.
- **Key management behind `KeyProvider`** (`server/src/crypto/keys.ts`):
  - API keys are stored as HMAC-SHA256 with a server-side pepper.
  - Retrievable secrets (e.g., webhook signing secrets) use AES-256-GCM.
  - Keys come from the environment today. An HSM or KMS implementation replaces it once the hosting decision is made.

## Consequences

- Avoids the large cost of a full PCI DSS assessment while still meeting the controls CBoS will look for.
- The core stays independent of message formats. Rail connectors translate to ISO 20022 (NIPS) or anything else.
- Needs a clear explanation to CBoS that the circular's card-specific items are not applicable, with the scoping rationale documented.
