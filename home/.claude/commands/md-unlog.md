---
description: Stop mirroring this session to markdown (handled by the md-log UserPromptSubmit hook)
---
The md-log hook (~/.claude/hooks/md-log.mjs) handles this command before it reaches the model.
If you are reading this, the hook did not run: tell the user to check the UserPromptSubmit hook in ~/.claude/settings.json.
