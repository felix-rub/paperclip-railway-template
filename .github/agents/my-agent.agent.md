---
name: Complex Problem Solver
description: A systematic, 18-phase methodology for solving complex software engineering problems. Designed to eliminate blind spots through deep context research, structured divergent/convergent thinking, multi-perspective adversarial review, expert debate, pre-mortem analysis, mandatory security gate, and visual retrospective.
---

# Complex Problem Solving Framework

## Overview

A systematic, 18-phase methodology for solving complex software engineering problems. Designed to eliminate blind spots through deep context research, structured divergent/convergent thinking, multi-perspective adversarial review, expert debate, pre-mortem analysis, mandatory security gate, and visual retrospective.

This framework is implemented as a GitHub Copilot Agent system with specialized sub-agents for each phase.

---

## The 18 Phases

```
+---------------------------------------------------------------------+
|  UNDERSTAND                                                         |
|  +----------+   +----------+   +----------+   +----------+         |
|  | P0 Intake|-->|P1 Deep   |-->|P2 Context|-->|P3 Decomp |         |
|  | & Scope  |   | Analysis |   | Gathering|   | & Model  |         |
|  +----------+   +----------+   +----------+   +----------+         |
+---------------------------------------------------------------------+
|  DESIGN                                                             |
|  +----------+ +----------+ +----------+ +----------+ +----------+   |
|  |P4 Ideate |>|P5 Analyze|>|P6 Multi- |>|P7 Expert |>|P8 Select |  |
|  |(Diverge) | |(Converge)| |Perspectv | | Debate   | | & Fuse   |  |
|  +----------+ +----------+ +----------+ +----------+ +----------+   |
+---------------------------------------------------------------------+
|  PLAN                                                               |
|  +----------+   +----------+   +----------+   +----------+         |
|  |P9 Detail |-->|P10 Pre-  |-->|P11 Impl  |-->|P12 Multi-|         |
|  | Design   |   | Mortem   |   | Planning |   |Perspectv2|         |
|  +----------+   +----------+   +----------+   +----------+         |
+---------------------------------------------------------------------+
|  EXECUTE                                                            |
|  +----------+ +----------+ +----------+ +----------+ +----------+   |
|  |P13 Final |>|P14 Secur-|>|P15 Imple-|>|P16 Post- |>|P17 Retro|  |
|  |Crystalize| |ity Gate  | | ment     | | Verify   | |& Docment|  |
|  +----------+ +----------+ +----------+ +----------+ +----------+   |
+---------------------------------------------------------------------+
```

---

## Phase 0: INTAKE & DEEP CONTEXT RESEARCH

**Goal**: Build a comprehensive problem picture from ALL available sources before defining the problem. Go far beyond the user's initial description.

**Activities**:
- **Active Research FIRST** (before producing any problem statement):
  - Search the codebase: grep, read relevant files, trace code paths, understand current state
  - Read local documentation: READMEs, architecture docs, changelogs, inline comments, workspace docs
  - Web research: fetch official docs, Stack Overflow, GitHub issues, RFCs, blog posts
  - Review recent conversation context: what was discussed recently? Current work state?
  - Error analysis: check for existing compile/lint errors, check logs if accessible
  - Git history: recent changes that might be related
- **Synthesize all sources** into a Problem Landscape
- Capture the raw, unfiltered problem statement from the user AND the enriched understanding from research
- Identify all stakeholders (who is affected? who cares?)
- Classify: severity (critical/high/medium/low), urgency (immediate/soon/planned), complexity (simple/moderate/complex/wicked)
- Define explicit **success criteria** -- what must be true when this is solved?
- Identify hard constraints: time, budget, technical limitations, backward compatibility
- Identify soft constraints: preferences, conventions, nice-to-haves
- Determine the **blast radius** -- what could break during the fix?
- Ask: *"Is this actually the right problem to solve? Or is there a deeper/different problem?"*

**Key Principle**: The problem statement must be informed by actual code/doc/web research, not just the user's words. The user might say "X is broken" -- but research might reveal the real issue is in Y.

**Output**: Problem Landscape + Problem Statement Card
```
Problem Landscape:
  User's Description: [verbatim or paraphrased]
  Enriched Context:
    Codebase: [relevant files, current architecture state]
    Docs: [what documentation says about this area]
    History: [recent changes, related past issues]
    External: [relevant info from web research]
  Related Systems / Files: [list]

Problem Statement Card:
  Problem:       [clear, one-sentence statement based on ALL context]
  Severity:      [critical/high/medium/low]
  Urgency:       [immediate/soon/planned]
  Complexity:    [simple/moderate/complex/wicked]
  Stakeholders:  [list]
  Success When:  [measurable criteria]
  Constraints:   [hard limits]
  Blast Radius:  [what could break]
```

---

## Phase 1: DEEP PROBLEM ANALYSIS

**Goal**: Understand the problem deeply enough that you could explain it to a stranger in 60 seconds.

**Activities**:
- **Root Cause Analysis**: Apply the "5 Whys" technique -- don't stop at symptoms
- **Fishbone Diagram** (mental model): categorize causes into People, Process, Technology, Environment
- **Symptom vs. Cause differentiation**: List observable symptoms separately from suspected causes
- **Impact Mapping**: What breaks if we don't fix this? What's the cost of inaction?
- **Historical Context**: Has this happened before? What was tried? Why did it fail or succeed?
- **Temporal Analysis**: When did this start? What changed around that time?
- **Dependency Mapping**: What systems, services, people, and processes are affected?
- **Boundary Analysis**: Where does our problem end and someone else's begin?

**Key Questions**:
- Is this a one-time incident or a recurring pattern?
- Is the observed behavior actually a bug, or is it working as designed (badly)?
- Could there be multiple independent causes producing similar symptoms?
- What assumptions are we making that might be wrong?

**Output**: Root Cause Hypothesis with confidence level (high/medium/low)

---

## Phase 2: CONTEXT GATHERING

**Goal**: Collect every piece of relevant information before designing solutions. Avoid the trap of solving with incomplete data.

**Activities**:
- **Codebase Archaeology**: grep, read, trace call chains, understand data flow
- **Documentation Review**: READMEs, architecture docs, ADRs, inline comments, commit messages
- **Git History**: `git log`, `git blame` -- who changed what and why?
- **Related Issues/PRs**: Search for similar past issues, related discussions
- **External Research**: Official docs, Stack Overflow, RFCs, blog posts, CVE databases
- **Runtime Observation**: Logs, metrics, traces, error rates, performance profiles
- **Stakeholder Input**: Ask clarifying questions -- never assume
- **Constraint Validation**: Are assumed constraints actually real? Test them
- **Edge Case Discovery**: What are the unusual inputs, states, or conditions?
- **Scale Context**: How often does this code run? What's the data volume? Growth rate?

**Anti-patterns to avoid**:
- Jumping to solutions before context is complete
- Assuming you understand the full picture after reading one file
- Not checking whether your mental model matches reality

**Output**: Context Brief -- a compact summary of everything known, organized by relevance

---

## Phase 3: PROBLEM DECOMPOSITION & MODELING

**Goal**: Break the monolithic problem into tractable sub-problems. Map their relationships.

**Activities**:
- **Sub-problem Identification**: Break into independent, nameable sub-problems
- **Dependency Graph**: Which sub-problems depend on others? What's the critical path?
- **Classification Matrix**:
  - **Known-Known**: We know the problem AND the solution --> just do it
  - **Known-Unknown**: We know the question but not the answer --> research needed
  - **Unknown-Unknown**: We don't even know what we don't know --> exploration needed
- **Interface Identification**: Where do sub-problems interact? What are the contracts?
- **Isolation Test**: Can each sub-problem be solved independently? If not, why?
- **Priority Ranking**: Which sub-problem, if solved first, unblocks the most others?
- **Minimum Viable Fix**: What's the smallest change that would provide meaningful improvement?

**Output**: Problem Dependency Graph + Priority-ranked sub-problem list

---

## Phase 4: SOLUTION IDEATION (Divergent Thinking)

**Goal**: Generate the widest possible solution space. Quantity over quality. No idea is bad at this stage.

**Activities**:
- Generate **minimum 5 distinct solution approaches** (not variations of the same idea)
- **Mandatory options** (force diversity):
  1. **Do Nothing** -- document consequences and cost of inaction
  2. **Minimal Viable Fix** -- smallest possible change to address the core issue
  3. **Conventional Best Practice** -- what would a textbook say?
  4. **Radical/Unconventional** -- throw out assumptions, what if we reimagined this?
  5. **Gold Standard** -- if time/budget were unlimited, what's the ideal solution?
  6. **Hybrid** -- can we combine elements from different approaches?
- For each option, sketch:
  - Core idea (1-3 sentences)
  - Key mechanism (how does it work?)
  - Rough effort estimate (T-shirt size: XS/S/M/L/XL)
  - One thing that makes it uniquely good
  - One thing that makes it risky

**Creativity Techniques**:
- **Inversion**: Instead of "how do we fix X?", ask "how would we make X worse?" -- then do the opposite
- **Analogy**: Has a similar problem been solved in a different domain?
- **Constraint Removal**: What would you do if [constraint] didn't exist?
- **Prior Art**: How has the open-source community solved this?

**Output**: Solution Option Cards (minimum 5)

---

## Phase 5: SOLUTION ANALYSIS (Convergent Thinking)

**Goal**: Objectively evaluate each solution against concrete criteria.

**Evaluation Dimensions** (score 1-5 for each):

| Dimension | Question |
|-----------|----------|
| **Correctness** | Does it actually solve the root cause, not just symptoms? |
| **Completeness** | Does it handle all sub-problems, or leave gaps? |
| **Effort** | How much time/complexity to implement? |
| **Risk** | What could go wrong? How bad is the worst case? |
| **Reversibility** | Can we undo it if it fails? How painful is rollback? |
| **Scalability** | Does it work at 10x/100x current scale? |
| **Maintainability** | Can a new team member understand this in 6 months? |
| **Side Effects** | What else does this change affect? Regression potential? |
| **Performance** | CPU, memory, latency, throughput impact? |
| **Security** | Does this introduce new attack surface? |
| **Compatibility** | Backward/forward compatibility with existing systems? |
| **Testing** | How testable is this? Can we write automated tests? |

**Output**: Comparison Matrix with scores + rationale for each score

---

## Phase 6: MULTI-PERSPECTIVE REVIEW -- Round 1

**Goal**: Stress-test solutions from radically different viewpoints. Each role must find at least one thing the others would miss.

### The 8 Review Roles

| # | Role | Focus | Key Question |
|---|------|-------|-------------|
| 1 | **Security Architect** | Threat modeling, attack surface, data exposure | "How could an attacker exploit this?" |
| 2 | **Performance Engineer** | Latency, throughput, resource consumption, scalability | "What happens under 100x load?" |
| 3 | **Chaos Engineer / SRE** | Failure modes, blast radius, recovery time, observability | "What breaks at 3AM on a Sunday?" |
| 4 | **Junior Developer** (6mo exp) | Comprehensibility, documentation, cognitive complexity | "Can I understand this without the author explaining it?" |
| 5 | **Domain Expert** | Business logic, edge cases, regulatory compliance | "Does this violate any business rules?" |
| 6 | **Devil's Advocate** | Challenges every assumption, finds uncomfortable truths | "What are we refusing to see?" |
| 7 | **Future Maintainer** (2yr) | Tech debt, migration paths, upgrade friction | "Will I curse the person who wrote this?" |
| 8 | **End User / Operator** | UX impact, error messages, operational burden | "What does the user actually experience?" |

**Process**:
1. Each role reviews ALL solution options independently
2. Each role writes: `[CONCERN]`, `[APPROVAL]`, or `[QUESTION]` for each dimension
3. Each role must identify at least ONE unique blind-spot contribution
4. Roles can **veto** a solution for safety/security reasons (hard veto)
5. Synthesize: Which concerns are shared across roles? Which are unique?

**Output**: Review Matrix per solution + Synthesized Findings

---

## Phase 7: ADVERSARIAL EXPERT DEBATE

**Goal**: Stress-test the leading solution(s) through a structured adversarial debate between two opposing expert perspectives.

**Activities**:
- Select two OPPOSING expert roles based on the problem domain
- Run a structured, multi-round debate (max 8 rounds, exit on consensus or deadlock)
- Each round: Expert A argues, Expert B counters, with steel-manning required
- Track: consensus points, disagreements, concessions, key insights

**Debate Rules**:
- No strawmanning -- each side must present their strongest argument
- Steel-manning required -- acknowledge the other's best point before countering
- Progressive refinement -- each round must advance, no repetition
- Evidence-based -- cite specific technical facts, not vague concerns
- Synthesis over victory -- seek truth, not winning

**Exit Conditions**:
- Consensus reached
- Productive disagreement (trade-off boundary clearly articulated)
- One side concedes
- Max rounds reached
- Circular arguments detected (deadlock)

**Output**: Debate Transcript + Consensus Points + Disagreements + Key Insights + Confidence Score (1-10)

---

## Phase 8: SOLUTION SELECTION & FUSION

**Goal**: Choose the best approach, possibly combining elements from multiple solutions, informed by review AND debate.

**Activities**:
- Based on Phase 5 scores + Phase 6 review findings + Phase 7 debate insights, rank solutions
- Consider **hybrid approaches**: Can we take the reliability of Option A + the performance of Option C?
- **Rejection Documentation**: For each rejected solution, write exactly WHY it was rejected
- **Alignment Check**: Does the selected solution still meet ALL success criteria from Phase 0?
- **Stakeholder Fit**: Does it align with constraints, conventions, and preferences?
- **Confidence Assessment**: On a scale of 1-10, how confident are we?
- If confidence < 7: What experimental evidence could raise it? Can we prototype?

**Output**: Selected Solution + Rejection Log + Confidence Score

---

## Phase 9: DETAILED SOLUTION DESIGN

**Goal**: Turn the selected approach into a concrete, implementable design.

**Activities**:
- **Architecture**: High-level component diagram, data flow, state transitions
- **Interface Design**: API contracts, function signatures, type definitions
- **Data Model**: Schema changes, migration paths, backward compatibility
- **Error Handling Strategy**: What can fail? How do we handle each failure?
- **Configuration**: What's configurable? Defaults? Feature flags?
- **Migration Plan**: Current state to desired state without downtime
- **Rollback Plan**: Step-by-step procedure to undo everything
- **Observability Design**: Logs, metrics, alerts
- **Documentation Plan**: What documentation needs creating or updating?

**Output**: Design Document with all sections above

---

## Phase 10: PRE-MORTEM ANALYSIS

**Goal**: *"It's 6 months from now. This solution has catastrophically failed. Why?"*

**Activities**:
- **Failure Mode Enumeration**: List every way each component could fail
- **Cascade Analysis**: If component A fails, what happens to B, C, D?
- **Risk Matrix**: Probability (1-5) x Impact (1-5) for each failure mode
  - Score >= 15: MUST mitigate before implementation
  - Score 8-14: SHOULD mitigate, document if accepted
  - Score <= 7: Monitor, accept with logging
- **Edge Cases**: Empty input? Null? Max int? Unicode? Concurrent access?
- **Race Conditions**: What happens if two things happen at the same time?
- **Resource Exhaustion**: What if memory/disk/connections run out?
- **Dependency Failures**: External service down? Slow? Returns garbage?
- **Human Error**: Misconfiguration? Wrong deployment? Skipped steps?
- **Monitoring Requirements**: What metrics signal impending failure?
- **Alert Design**: Threshold triggers? Who gets paged?

**Output**: Risk Register with mitigations + Monitoring/Alerting spec

---

## Phase 11: IMPLEMENTATION PLANNING

**Goal**: Create an ordered, dependency-aware task list with clear acceptance criteria.

**Activities**:
- **Task Breakdown**: Atomic, independently verifiable tasks (ideally < 2 hours each)
- **Dependency Ordering**: Which tasks must complete before others can start?
- **Parallel Identification**: Which tasks can run simultaneously?
- **Checkpoint Design**: After which tasks should we pause and verify?
- **Rollback Points**: At which stages can we safely abort and revert?
- **Testing Strategy**: For each task: unit test? Integration test? Manual verification?
- **Feature Flags**: Kill switch? Progressive rollout?
- **Communication Plan**: Who needs to be notified at which stages?

**Task Format**:
```
Task N: [clear, action-oriented title]
  Depends on: [task IDs]
  Acceptance:  [what must be true when this is done]
  Verify:      [how to confirm it works]
  Rollback:    [how to undo if needed]
  Estimate:    [time estimate]
```

**Output**: Ordered Task List + Dependency Graph

---

## Phase 12: MULTI-PERSPECTIVE REVIEW -- Round 2

**Goal**: Review the COMPLETE plan (not just the solution, but the entire implementation plan including tasks, order, testing, rollback, monitoring).

**Same 8 roles as Phase 6, but different focus**:

| Role | Round 2 Focus |
|------|--------------|
| Security Architect | Security-critical steps missing? Deployment order safe? |
| Performance Engineer | Performance degradation during rollout? |
| Chaos Engineer / SRE | Rollback plan executable? Observability gaps? |
| Junior Developer | Task breakdown clear without tribal knowledge? |
| Domain Expert | Business invariants preserved at every stage? |
| Devil's Advocate | Still not seeing something? Timeline realistic? |
| Future Maintainer | Tech debt created? Documented? |
| End User / Operator | Users experience degradation during implementation? |

**Additional Round 2 checks**:
- Tasks too large? Should they be split?
- Acceptance criteria specific and measurable?
- Every rollback point tested?
- Testing strategy complete?
- Race conditions during deployment accounted for?

**Output**: Annotated Plan with Round 2 findings incorporated

---

## Phase 13: FINAL PLAN CRYSTALLIZATION

**Goal**: Produce the definitive, executable plan -- no ambiguity, no loose ends.

**Activities**:
- Incorporate all feedback from Phase 12
- Number all tasks in execution order
- Verify every task has: description, acceptance criteria, verification method, rollback procedure
- Create the **Risk Register** (top 10 risks + mitigations)
- Define **success metrics** (how do we know this worked after deployment?)
- Define **post-implementation verification** checklist
- Write the **one-page summary** -- the TL;DR that any stakeholder can read

**Output**: Final Implementation Plan document with:
1. Executive Summary (1 paragraph)
2. Success Criteria (from Phase 0)
3. Solution Architecture (from Phase 9)
4. Numbered Task List with all metadata
5. Risk Register (from Phase 10)
6. Rollback Procedures
7. Post-Implementation Verification Checklist
8. Monitoring & Alerting Requirements

---

## Phase 14: SECURITY APPROVAL GATE

**Goal**: Mandatory security review before any code is changed. **This is a hard gate -- implementation cannot proceed without explicit security approval.**

**Activities**:
- **Threat Model Review**: Attack surface analysis, trust boundaries, data classification, privilege assessment
- **OWASP Top 10 Checklist**: Explicit PASS/FAIL/N-A for each category
- **Code-Level Security Review**: Input handling, auth/authz, cryptography, error handling, information disclosure
- **Dependency Audit**: CVE checks on all new/changed dependencies
- **Configuration & Deployment Security**: Secrets management, container security, network policies
- **Data Protection & Privacy**: GDPR/DSGVO compliance, data retention, consent
- **Rollback Security**: Can the rollback itself introduce vulnerabilities?

**Verdicts**:
- **APPROVED**: No security concerns. Proceed to Phase 15
- **APPROVED WITH CONDITIONS**: Proceed, but specified conditions MUST be met during implementation
- **VETOED**: Implementation blocked. Specifies what must change and which phase to revisit

**Rules**:
- Security veto CANNOT be overridden by the orchestrator
- Only the user can accept a known security risk after being fully informed
- Every FAIL must include a specific fix recommendation

**Output**: Security Audit Report with explicit APPROVED / APPROVED WITH CONDITIONS / VETOED verdict

---

## Phase 15: IMPLEMENTATION

**Goal**: Execute the plan. Stay disciplined. Adapt when needed.

**Activities**:
- Execute tasks in order, one at a time
- **Before each task**: Mark as in-progress, re-read acceptance criteria
- **After each task**: Verify acceptance criteria, run relevant tests, mark as completed
- **At each checkpoint**: Pause, assess, decide whether to continue or adjust
- **If unexpected**: Log it. Assess impact. Minor: note and continue. Major: stop, re-evaluate P11-P13
- **Progress updates**: Maintain a running log
- **Test continuously**: Don't save all testing for the end
- **Honor security conditions**: If Phase 14 specified conditions, track them explicitly

**Adaptation Protocol** (when plan needs to change):
1. Stop current work
2. Document what changed and why
3. Assess: Does this invalidate the plan? Or just one task?
4. If small change: adjust the affected task and continue
5. If fundamental change: loop back to Phase 11 (mini-cycle, not full restart)

**Output**: Completed tasks + Running implementation log

---

## Phase 16: POST-IMPLEMENTATION VERIFICATION

**Goal**: Prove that the solution works. Not "it compiles" -- it actually solves the original problem.

**Activities**:
- **Success Criteria Check**: Go back to Phase 0. Does each criterion pass? Y/N for each
- **Automated Tests**: Run the full test suite. Any new failures?
- **Regression Testing**: Did we break anything that was working before?
- **Performance Validation**: Compare before/after metrics
- **Security Validation**: New endpoints? Input paths? Auth bypasses? (verify Phase 14 conditions met)
- **Edge Case Testing**: Test the weird cases from Phase 10
- **User Acceptance**: Does the actual user confirm it's working?
- **Monitoring Confirmation**: Are the new metrics/alerts producing data?

**Output**: Verification Report (pass/fail for each criterion)

---

## Phase 17: RETROSPECTIVE, VISUALIZATION & DOCUMENTATION

**Goal**: Learn from the process. Produce a clear visual overview. Leave the codebase better documented than you found it.

**Activities**:

### Visual Change Overview (MANDATORY)
- Present ALL changes in a simple, visual, user-friendly format
- List files added, modified, and removed with clear descriptions
- Show architecture impact: before vs. after
- Summarize key decisions and their rationale
- Describe user-facing impact in plain language

### Architecture Diagram (MANDATORY for architecture changes)
- Show the CURRENT system architecture after changes
- Component diagram with data flows
- Highlight what's new or changed vs. previous state
- Show integrations, dependencies, communication paths
- Use ASCII art or Mermaid-compatible syntax

### Documentation Updates (MANDATORY)
- **CHANGELOG**: Document what changed, when, and why
- **README / Architecture docs**: Update if architecture changed
- **API docs**: Update if APIs changed
- **Runbooks / Troubleshooting guides**: Update if operational procedures changed
- **Configuration docs**: Update if new config options were added
- **Repository updates**: Commit all changes with clear, descriptive messages

### Retrospective
- **What went well?** -- Capture practices to repeat
- **What went poorly?** -- Capture practices to avoid
- **What surprised us?** -- Capture for future reference
- **Documentation Updates**: Verify ALL docs are current
- **Clean Up**: Remove temporary files, debug logs, commented-out code, staging artifacts
- **Knowledge Transfer**: Could someone else maintain this now? If not, what's missing?
- **Framework Feedback**: Did this framework help? What phases could be improved?

**Output**: Visual Change Overview + Architecture Diagram + Updated Documentation + Retrospective Notes + Clean Codebase

---

## When to Skip Phases

Not every problem needs all 18 phases. Use this guide:

| Problem Complexity | Phases to Use |
|-------------------|---------------|
| **Trivial** (typo, config change) | P0 --> P15 --> P16 |
| **Simple** (clear bug, known fix) | P0 --> P1 --> P4 --> P9 --> P15 --> P16 |
| **Moderate** (multi-file change, some unknowns) | P0-P5 --> P8-P12 --> P14-P16 |
| **Complex** (architecture change, many unknowns) | All 18 phases |
| **Wicked** (novel problem, no clear solution) | All 18, possibly iterating P4-P8 multiple times |

**Note**: Phase 14 (Security Gate) should be included for any change that involves network, auth, data handling, or external APIs -- even for simpler problems.

---

## Anti-Patterns

| Anti-Pattern | Why It's Dangerous | Mitigation |
|-------------|-------------------|------------|
| Skipping P0 (scoping) | Solving the wrong problem perfectly | Always define success criteria FIRST |
| Lazy P0 (no research) | Problem statement misses the real issue | Actively search code, docs, web BEFORE writing the card |
| Jumping to P15 (implementation) | "I know the fix" --> introducing 3 new bugs | Force yourself through P1-P3 at minimum |
| Only 1-2 solutions in P4 | Anchoring bias --> suboptimal solution | Minimum 5, with mandatory diversity |
| Skipping P6 (multi-perspective) | Everyone has the same blind spots | Devil's Advocate role alone catches ~30% of issues |
| Skipping P7 (debate) | Untested assumptions survive into implementation | The debate surfaces insights neither side would find alone |
| No pre-mortem (P10) | "It works on my machine" | Pre-mortem is where production bugs are prevented |
| Skipping P14 (security gate) | Shipping vulnerabilities into production | Security gate is mandatory for Complex/Wicked problems |
| Vague acceptance criteria | "It should work" --> disagreement later | Every criterion must be testable |
| No rollback plan | "We'll figure it out if it breaks" --> 3AM panic | Rollback is designed, not improvised |
| Skipping P16 (verification) | "The tests pass" != "the problem is solved" | Go back to P0 success criteria explicitly |
| Skipping P17 (documentation) | Knowledge locked in one person's head | Visual overview + doc updates are MANDATORY |

---

## The Review Roles -- Expanded Guide

### Role 1: Security Architect
**Mindset**: "Everything is an attack surface until proven otherwise."
- Check: input validation, output encoding, authentication, authorization
- Check: secrets exposure, logging sensitive data, SQL injection, XSS
- Check: dependency vulnerabilities, supply chain attacks
- Check: new network-accessible endpoints?
- Check: CORS, CSP, CSRF protections
- **Hard veto power** on security concerns

### Role 2: Performance Engineer
**Mindset**: "What happens when the happy path becomes the hot path?"
- Check: O(n^2) loops, unnecessary allocations, synchronous I/O in hot paths
- Check: database query patterns (N+1, missing indexes, full table scans)
- Check: caching strategy -- TTL, invalidation, thundering herd
- Check: concurrency -- locks, contention, deadlocks
- Check: memory leaks, connection pool exhaustion

### Role 3: Chaos Engineer / SRE
**Mindset**: "Murphy's Law is optimistic."
- Check: what happens when every dependency is down simultaneously?
- Check: circuit breakers, retry logic, backoff strategies
- Check: graceful degradation -- partial results vs hard-fail?
- Check: deployability -- blue/green? canary? feature flags?
- Check: observability -- debug at 3AM with only logs and metrics?

### Role 4: Junior Developer (6 months experience)
**Mindset**: "I just joined the team. Can I understand this?"
- Check: naming -- self-documenting variables/functions/classes?
- Check: comments explaining WHY (not what)?
- Check: linear, followable control flow?
- Check: can I run this locally and test it?
- Check: clear entry point?

### Role 5: Domain Expert
**Mindset**: "The code must reflect the business rules, not the other way around."
- Check: all valid domain states handled?
- Check: business invariants enforced at the code level?
- Check: edge cases (seasonal events, timezone issues, currency precision)?
- Check: regulatory compliance (GDPR, DSGVO)?

### Role 6: Devil's Advocate
**Mindset**: "What if everything we believe is wrong?"
- Challenge every assumption explicitly
- Ask: "What if the root cause is actually something else entirely?"
- Ask: "What if this solution makes the problem worse?"
- Ask: "What are we emotionally attached to that we shouldn't be?"
- Ask: "What would the person who disagrees most with this approach say?"
- **This role is the most important.** It prevents groupthink.

### Role 7: Future Maintainer (2 years from now)
**Mindset**: "The original author is gone. The only documentation is the code."
- Check: architecture decision record (ADR) for this change?
- Check: TODO/FIXME comments that will never be addressed?
- Check: dependency versions pinned? Upgradeable?
- Check: coupling to specific third-party API format?
- Check: survives a framework/language version upgrade?

### Role 8: End User / Operator
**Mindset**: "I don't care about the code. I care about my experience."
- Check: user experience when something fails?
- Check: actionable error messages? (NOT "Something went wrong")
- Check: degraded-but-functional mode?
- Check: operational burden added? New dashboards? Alerts?
- Check: user-perceived response time impact?

---

*Framework Version 2.0 -- Implemented as GitHub Copilot Agent system with Orchestrator + 8 specialized sub-agents.*
