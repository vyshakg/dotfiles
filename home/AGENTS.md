# global agent instructions

- Never use the em dash "—". Use plain dash "-" instead
- When writing commit messages, NEVER auto-add your agent name as co-author
- Never manually modify CHANGELOG.md files or any files that are marked as auto-generated
- When making technical decisions, do not give much weight to development cost.
  Instead, prefer quality, simplicity, robustness, scalability, and long term maintainability.
- For one-off or infrequent operational work, start with the simplest direct end-to-end path. Do not build wrappers, control planes, policy layers, custom verifiers, or automation unless the direct path exposes a concrete blocker or repeated need that justifies the added machinery.
- When doing bug fixes, always start with reproducing the bug in an E2E setting as closely aligned with how an end user would experience it as possible.
  This makes sure you find the real problem so your fix will actually solve it.
- When end-to-end testing a product, be picky about the UI you see and be obsessed with pixel perfection.
  If something clearly looks off, even if it is not directly related to what you are doing, try to get it fixed along the way.
- Apply that same high standard to engineering excellence: lint, test failures, and test flakiness.
  If you see one, even if it is not caused by what you are working on right now, still get it fixed.

# No guessing

All design authority belongs to the human. **Never guess a design or implementation decision.**
If anything is ambiguous (naming, behavior, data shapes, UX, defaults, scope boundaries, prompt wording), STOP and ask with the AskUserQuestion tool before proceeding.
If you are "a little unsure", you are unsure: ask. A wrong guess is far more expensive than a question.
Ask early and be specific, one question per call.
Do not ask about things you can verify from the code or that have an obvious conventional default; pick it and mention it.

Concretely: first investigate and plan rigorously (asking the user design questions along the way), get the plan approved by the user, and only then implement.
Implementation should be mechanical execution of an approved plan, not interpretation.
