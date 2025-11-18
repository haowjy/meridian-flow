Phase 1 (MVP - NOW)
  1. User-scoped skills (hidden .skills/ folder per user)
  2. User selects skills when creating chat (dropdown/checkboxes)
  3. Selected skills → fully loaded into system prompt upfront
  4. No dynamic loading (simpler to build, still useful)

  System prompt composition (resolved at request time):
  1. request_params.system (user-provided in API request)
  2. project.system_prompt (project settings)
  3. chat.system_prompt (chat settings)
  4. selected_skills (from .skills/{skill_name}/SKILL)

  Note: turns.system_prompt column has been removed (migration 00003)

  Future (Phase 2)
  1. Add view_skill() tool for dynamic loading
  2. LLM can load skills mid-conversation
  3. Project skills auto-context (frontmatter only initially)
  4. Smart auto-detection

  Why This MVP Works

  ✅ Immediately useful - Users get skill-based chat templates
  ✅ Simple to build - No tool protocol, just string concatenation
  ✅ Matches user flow - User knows what task they're doing (prose vs. brainstorming)
  ✅ Extensible - Can add dynamic loading later without breaking changes

  MVP Architecture

  users/
  └── {user_id}/
      └── .skills/           # Hidden folder (not in regular file tree)
          ├── cw-prose-writing/
          │   ├── main.md
          │   └── examples.md
          └── cw-brainstorm/
              └── instructions.md

  Chat creation:
  - User selects: ["cw-prose-writing"]
  - System loads: .skills/cw-prose-writing/**/*.md
  - Concatenates into system prompt
  - All turns in chat use this