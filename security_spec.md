# Security Specification

## Data Invariants
1. A configuration document must have valid types for its fields.
2. A conversation must have an `updatedAt` server timestamp.
3. Chat messages must be within a conversation, and cannot modify existing messages except their status.
4. Access is restricted to authenticated users.

## 12 "Dirty Dozen" Payloads
1. Null token: `{"whatsappToken": null}` (State violation)
2. Oversize prompt: `{"botPrompt": "A".repeat(15000)}` (Resource exhaustion)
3. Ghost field config: `{"adminBypass": true}`
4. Unverified user: `request.auth.token.email_verified == false`
5. Overwrite id: `{"id": "new"}` (Identity spoofing)
6. Fake Timestamp: `{"updatedAt": 123456789}` instead of `request.time`
7. Array injection: `{"quickReplies": [{"malicious": "object"}]}`
8. Large Array: `{"quickReplies": ["1", ..., "1001"]}`
9. Invalid Message Role: `{"role": "admin"}`
10. Orphaned Message: `message` creation on Non-existent `conversation`.
11. Status Regression: changing message status from `read` to `failed`.
12. Bad ID variable: 1MB ID string.

## Test Runner
Defined in `firestore.rules.test.ts`.
