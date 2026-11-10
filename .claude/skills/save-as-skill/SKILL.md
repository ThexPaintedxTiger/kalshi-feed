---
name: save-as-skill
description: "This project's convention for saving a script Claude wrote and tested as a reusable skill in .claude/skills/<name>/ (YAML front matter with what/when/not-for description, register in docs/skills.md and CLAUDE.md). Use when a script in this repo will be reused, or the owner says save this as a skill/tool. Not for general skill design, evals or skills outside this repo (use anthropic-skills:skill-creator)."
---

# Save a working script as a project skill

Use for scripts Claude wrote that will be reused in this project. Only save something that has run successfully.

1. Test it first (run it; add a case to `test.mjs` if it does math).
2. Shared code goes in the repo root (or `lib.mjs`) if the GitHub Action uses it; one-off helpers go next to the skill:
   `.claude/skills/<name>/<script>`.
3. Create `.claude/skills/<name>/SKILL.md`:
   ```yaml
   ---
   name: <name>            # lowercase-with-dashes, same as the folder
   description: "<what it does>. Use when <trigger phrases/situations>. Not for <neighbor case> (use <other skill>)."
   ---
   ```
   Always double-quote the description: a colon followed by a space inside it breaks YAML.
   Body: exact commands, expected output, cost, failure handling. Keep it short.
4. Check for overlap with existing skills (`docs/skills.md`); if two would trigger on the same request, sharpen both descriptions.
5. Add a row to `docs/skills.md` (what / when / overlaps) and mention it in `CLAUDE.md → Skills`.
6. Check front matter parses: `python3 -c "import yaml,sys;print(yaml.safe_load(open(sys.argv[1]).read().split('---')[1]))" .claude/skills/<name>/SKILL.md`
