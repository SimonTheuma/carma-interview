---
name: carma-plan
description: Plan execution and project management for Carma features. Synthesises every carma-* skill output (architect, searchability, telemetry, data-sanity, DBA, devops, backend-testing, UX and ADRs) into one executable plan with detailed step-by-step tasks a human or agent can follow, phases of roughly 8 to 16 hours each, dependency-ordered tasks, and a consistency report listing contradictions and open questions that must be resolved before execution starts. Writes numbered specs to .specs/plan/. Use this last, whenever the user asks for an implementation plan, task breakdown, phasing, roadmap, "how do we build this", what order to do things in, or wants the carma specs combined, even if they do not name the skill.
---
 
# carma-plan
 
The other skills each look at one concern. This one looks across them. Its value is in what no single spec can see: where two specs disagree, where one assumes something another never provides, and what order the work has to happen in so each step can be verified. A plan that merely concatenates the specs hides those problems until execution, when they cost the most.
 
The plan must be usable by someone who has not read the specs: each task says what to do, where, with what inputs, and how to know it is done.
 
Read `references/carma-context.md` first for the principles, constraints and spec conventions.
 
## Inputs
 
Inventory what exists for the feature by listing, and reading the latest non-superseded spec in, each of:
 
- `.specs/architect/` and `.specs/architect/adrs/` (design, decisions, FP and HP registers)
- `.specs/search/`
- `.specs/telemetry/`
- `.specs/data/sanitization/`
- `.specs/data/dba/`
- `.specs/testing/backend/`
- `.specs/ux/`
- `.specs/devops/` (Compose topology, secrets, bring-up, deployment tests)
- earlier plans in `.specs/plan/` for the same feature
Report which are present and which are missing, and for each missing one say whether the feature needs it (the architect spec's downstream handoff says which skills apply). A missing spec that the feature needs is an open question, not something to fill with guesses. If nothing exists at all, say so and recommend starting with carma-architect.
 
Approved ADRs are decisions. Specs marked `UNCONFIRMED` or listing open decisions are not. Plan around the decided ones and surface the rest.
 
## Workflow
 
### 1. Consistency review
 
Before writing tasks, read the specs against each other and the context file. Look for:
 
- **Contradictions.** For example, the DBA plan relaxes durability while the architect spec requires no loss; the search design needs an extension the environment may not allow; the UX needs a field no spec produces; telemetry labels with high cardinality; a testing threshold that differs from the architect's.
- **Gaps.** A failure point (FP-n) with no test, a hot path (HP-n) with no measurement, a signal with no emitter, a table with no migration, a screen with no data source.
- **Unvalidated assumptions** from the context file's known unknowns (`published_at` accuracy, id uniqueness, Postgres version and extensions, size and mix of articles) that a design silently depends on.
- **Principle conflicts.** Where a choice trades P3 completeness, P2 reliability or P6 to P8 transparency for speed, and no decision records it.
- **Unmade decisions.** Open questions in any spec.
Classify each finding as a **blocker** (must be resolved before the affected work starts), a **risk** (proceed but track) or a **note**. For each blocker name who can resolve it and what the options are. If blockers need the user, ask now using the protocol in the context file; otherwise record them at the top of the plan.
 
### 2. Break the work into tasks
 
Create tasks that a human or agent can pick up and complete without further interpretation. Each task has:
 
- **ID and title** (verb first)
- **Why**: the requirement, decision (ADR number) or failure point it serves, and principles
- **Steps**: ordered, concrete actions
- **Where**: files, modules, tables or systems touched, with paths from the codebase analysis
- **Inputs and outputs**: what must exist before, what exists after
- **Acceptance criteria**: observable checks, including the test or measurement from the testing spec that proves it
- **Estimate**: hours as a range
- **Depends on**: task IDs
- **Owner type**: `agent`, `human`, or `either`, with the reason when `human` (a decision, a hot-path inspection the architect flagged, an approval, access to an environment)
- **Spec references**: the sections it implements
Include the tasks people forget: environments and test data, migrations and their rollbacks, the load generator and harness, telemetry emission, dashboards and alerts, security hardening, documentation of decisions. Human gates from the architect's hot path register become explicit tasks, not footnotes.
 
### 3. Order by dependency
 
Build the dependency graph and check it has no cycles. Derive the order from the graph, not from the order the specs were written. Identify the critical path and the work that can run in parallel, and say which parallel work needs different people or agents.
 
Prefer a **walking skeleton** early, starting from a single `docker compose up` that brings up the empty stack healthy (database, migrations, one worker, observability), then the thinnest end-to-end path (one article from ingestion through storage, search and telemetry) before widening any stage. It proves the pieces fit while changes are still cheap, and it gives the testing and telemetry work something real to measure. After each phase that changes a hot path, schedule a quick benchmark task (carma-benchmark) and a review task (carma-review) as a gate before the next phase, and say who runs them. Put risky unknowns (extension availability, write throughput, language analysis) early so they fail cheaply.
 
### 4. Group into phases
 
Decide how many phases the project needs. A phase should take roughly 8 to 16 hours of focused work (one to two days) executed end to end, and should end in something verifiable. Size by summing task estimates; split a phase that runs past 16 hours and merge ones under about 8 unless a dependency boundary forces them apart. Say if the estimates carry large uncertainty.
 
Each phase has:
 
- **Goal** in one sentence
- **Entry criteria** (what must be true to start, including resolved blockers)
- **Tasks** in execution order, with owner types
- **Exit criteria** (what is verified, by which test or measurement)
- **Total estimate** and the largest uncertainty in it
- **Rollback or safe-stop**: what state the system is in if work stops here
- **Human checkpoints**: decisions or inspections needed within the phase
A phase boundary should be a place where it is safe to pause and review.
 
### 5. Execution notes
 
Add what a person or agent running the plan needs: how to work through tasks and report status, what to do when a task's assumption turns out false (stop and raise it, do not improvise a design change), and when to return to a design skill (for example if measurements break a throughput assumption, rerun carma-architect or carma-dba with the new evidence).
 
## Output
 
Write the plan with these sections, in this order. Put the consistency findings first so nobody starts work on top of an unresolved blocker:
 
1. **Summary** (what is being built, number of phases, total estimate, critical path in one line)
2. **Inputs** (specs and ADRs used, with paths; missing specs and whether needed)
3. **Blockers and open questions** (must be actioned before execution; each with owner and options)
4. **Consistency report** (contradictions, gaps, unvalidated assumptions, principle conflicts; classified as blocker, risk or note)
5. **Dependency graph** (table of task dependencies plus a Mermaid or text diagram; critical path and parallel tracks marked)
6. **Phases** (each as described in step 4, with its tasks written out in full as in step 2)
7. **Traceability matrix** (requirement or FP/HP to task to test or measurement; any row with an empty cell is a gap)
8. **Risks and assumptions** (including the estimate uncertainty)
9. **Execution notes**
For a large plan, keep the overview in the main file and put each phase's full task detail in a section that is easy to link to, rather than splitting the plan across files that can drift apart.
 
## Persisting the work (when run inside a codebase)
 
If executed in a codebase, the output of this skill is numbered as a sequence in `.specs/plan`. Follow "Spec conventions" in the context file: number with `python scripts/next_spec_number.py .specs/plan`, write `.specs/plan/NNNN-<feature-slug>.md` with `spec: carma-plan` front matter and list every spec and ADR you used under `inputs`. Edit in place while `draft`. Once a plan is `approved`, a revised plan is a new numbered file with `supersedes` set, so the history of what was agreed stays intact. When a blocker is resolved by a human decision that should be binding, suggest recording it as an ADR through carma-architect and reference its number in the plan.
 
If you are not in a codebase, deliver the output in the conversation and offer to save it.