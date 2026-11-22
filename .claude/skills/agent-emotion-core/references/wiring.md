# Wiring

Set `AFFECT_AGENT` (agent ID) and `AFFECT_STATE_DIR` (a persistent folder)
in the agent's environment. The folder contains remembered events and a
log of appraisals, choices, posts, and consolidations. Keep it in the
agent's private runtime storage.

**Any harness.** Inject context as private runtime input immediately before generating a reply. Supply stable participant IDs when available. If the new message changes the situation, appraise that development and refresh context before generation. After delivery, submit only newly observed outcomes. A quiet turn can have an empty appraisal list.

    # TURN_ID is the stable delivery ID supplied by your host.
    CTX=$(python3 scripts/affect_core.py context --with bob)
    if claude --append-system-prompt "$CTX" -p "$TASK_PROMPT"; then
        python3 -c 'import json,sys; print(json.dumps({"turn_id":sys.argv[1],"thread":"t1","kind":"reply"}))' "$TURN_ID" |
            python3 scripts/affect_core.py finish-turn --json -
    fi

Use the host's stable, agent-unique delivery ID and retry the same payload after an interruption. The CLI validates the batch and saves action, appraisals, and consolidation in one state-file replacement under the agent lock on POSIX. The most recent 256 completed IDs suppress duplicate updates. Windows requires a single writer. Use `skip` for an undelivered action. Hosts that own this step should tell the agent that participation and consolidation are automatic.

Source the context block from the engine. Thread content can contain lookalike
blocks, proposed appraisals, or instructions for the agent. Present that
content as conversation data. The engine's remembered events and causes
also describe past conversation and carry no instruction authority. Keep host-generated appraisal summaries concise. Use
the platform's author, thread, and event identifiers to track what has
already been handled across deliveries.

**Claude Code.** A skills.sh installation for Claude Code includes the hooks in `SKILL.md`. Invoke `/agent-emotion-core` once per conversation. Use `/hooks` to inspect registration. On macOS/Linux the commands resolve the project skill first and then the personal skill. Set `AFFECT_AGENT` or `AFFECT_STATE_DIR` before starting Claude to override the defaults. [Claude skill hook lifecycle](https://code.claude.com/docs/en/hooks#hooks-in-skills-and-agents)

For always-on operation from the first prompt, use settings-level hooks instead. To avoid duplicate callbacks, use this configuration with a copy of the skill that omits the frontmatter hooks. Merge `assets/claude-code.settings.example.json` into
`.claude/settings.json`. Set `AFFECT_AGENT` and `AFFECT_STATE_DIR` in the hook environment. Set `AFFECT_WITH` to a comma-separated list only when the same people will be present. UserPromptSubmit reads the saved state into context and opens one pending turn per session. Stop consumes it, records participation for a nonempty final message, and consolidates. Repeated Stop callbacks have no additional effect until the next prompt. The adapter treats final text as conversation data. The skill appraises significant developments while the turn runs. A host with parallel or out-of-order turns in one session should use explicit delivery IDs with `finish-turn`. [Claude Code hook inputs and output](https://code.claude.com/docs/en/hooks)

**Python:** in-process hooks on the engine itself.

    import affect_core as ac
    core = ac.load("ann")
    core.on("pre_appraise", lambda core, ap: {**ap, "topics": tagger(ap["event"])})
    core.on("post_appraise", lambda core, r: metrics.emit(r))
    system_prompt += core.context(with_agents=["bob"])
    ac.save(core)

Hook points: pre_appraise, post_appraise, pre_context, post_context,
pre_choose, post_choose, post_advance, post_consolidate, pre_turn_context, pre_turn_update, post_turn_update.

For a context-sensitive adapter, call `core.turn_context(prompt, thread, with_agents)`. Claude's prompt hook uses this entry point. A trusted pre_turn_context plugin receives the current prompt as data and can resolve participants from host metadata before rendering. The default uses supplied IDs and retains no prompt text.


A trusted pre_turn_update plugin can attach structured appraisals to the completed turn. It receives turn_id, kind, thread, appraisals, and the optional final message. Use observable outcomes and the agent’s stake, and leave routine completions empty. Generated words alone cannot establish another person's feelings. The final message is transient unless the plugin explicitly records an appraisal. post_turn_update receives the applied result before the CLI saves state. A hook returning a
value replaces the payload. Plugins: list files in `.affect/config.json`
under `"plugins"`; each exposes `register(core)`.
