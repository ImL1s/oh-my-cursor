# Agents & Subagents Routing Parity

## Agent Personas & Hierarchy

| Agent | Surface | Upstream Analogs | Cursor Target | Disposition | Status |
|---|---|---|---|---|---|
| `Architect Agent Persona` | `agent` | {"omc":"omc_architect"} | `cursor-plugin-agent, cursor-sdk-subagent` | `native` | `pass` |
| `Critic Agent Persona` | `agent` | {"omc":"omc_critic"} | `cursor-plugin-agent, cursor-sdk-subagent` | `native` | `pass` |
| `Debugger Agent Persona` | `agent` | {"omc":"omc_debugger"} | `cursor-plugin-agent, cursor-sdk-subagent` | `native` | `pass` |
| `Executor Agent Persona` | `agent` | {"omc":"omc_executor"} | `cursor-plugin-agent, cursor-sdk-subagent` | `native` | `pass` |
| `Explore Reconnaissance Agent` | `agent` | {"omc":"omc_explore"} | `cursor-plugin-agent, cursor-sdk-subagent` | `native` | `pass` |
| `Planner Agent Persona` | `agent` | {"omc":"omc_planner"} | `cursor-plugin-agent, cursor-sdk-subagent` | `native` | `pass` |
| `QA Tester Agent Persona` | `agent` | {"omc":"omc_qa_tester"} | `cursor-plugin-agent, cursor-sdk-subagent` | `native` | `pass` |
| `Scientist Empirical Agent` | `agent` | {"omc":"omc_scientist"} | `cursor-plugin-agent, cursor-sdk-subagent` | `native` | `pass` |
| `Verifier Gatekeeper Agent` | `agent` | {"omc":"omc_verifier"} | `cursor-plugin-agent, cursor-sdk-subagent` | `native` | `pass` |
| `Writer Documentation Agent` | `agent` | {"omc":"omc_writer"} | `cursor-plugin-agent, cursor-sdk-subagent` | `native` | `pass` |
| `Analyst Requirements Agent` | `agent` | {"omx":"omx_analyst"} | `cursor-plugin-agent, cursor-sdk-subagent` | `native` | `pass` |
| `Build Fixer Agent` | `agent` | {"omx":"omx_build_fixer"} | `cursor-plugin-agent, cursor-sdk-subagent` | `native` | `pass` |
| `Code Simplifier Agent` | `agent` | {"omx":"omx_code_simplifier"} | `cursor-plugin-agent, cursor-sdk-subagent` | `native` | `pass` |
| `Git Master Hygiene Agent` | `agent` | {"omx":"omx_git_master"} | `cursor-plugin-agent, cursor-sdk-custom-tools` | `native` | `pass` |
| `Lead Orchestrator Agent Persona` | `agent` | {"omo":"omo_lead"} | `cursor-plugin-agent, cursor-sdk-subagent` | `native` | `pass` |
| `Worktree Worker Agent Persona` | `agent` | {"omo":"omo_worker"} | `cursor-plugin-agent, cursor-sdk-subagent` | `native` | `pass` |
| `Inspector Review Agent Persona` | `agent` | {"omo":"omo_inspector"} | `cursor-plugin-agent, cursor-sdk-subagent` | `native` | `pass` |

### Routing Architecture
- **Subagent Spawning**: Implemented using `@cursor/sdk` `Agent.createChild` and Cursor DAG runner patterns.
- **Model Tiers**: Fast, smart, and reasoning tiers mapped via `cursor-router`.
- **Tool Whitelisting**: Strict tool isolation per agent persona via plugin frontmatter.
