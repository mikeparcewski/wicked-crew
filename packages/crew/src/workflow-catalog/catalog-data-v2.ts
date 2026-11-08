/**
 * The v2 catalog seeds (DES-CATALOG-002 §3, §4.2, §4.6): ten verbs, one card per distinct needs, delivers or gate
 * shape, variants as options, every card and option with its slash command. GENERATED from the design's card
 * seeds (`design/catalog-v2/cards.json`); edit the seeds through a design revision, not here.
 *
 * Data, not policy: `gate` here is what the design SAYS each card is checked by. What a card SHOWS is derived
 * from the preset the engine serves (`build-v2.ts`), and a test pins that the two agree for every built-in.
 */
import type { CardSeedV2, CategorySeedV2 } from './seeds-v2.js';

export const CATALOG_V2_CATEGORIES: readonly CategorySeedV2[] = [
  {
    "id": "plan",
    "title": "Plan",
    "summary": "Work out what to do before anyone builds it."
  },
  {
    "id": "build",
    "title": "Build",
    "summary": "Change a repository: a pull request after QE acceptance, judged on a seat that did not build it."
  },
  {
    "id": "test",
    "title": "Test",
    "summary": "Plan tests, write them, and keep the suite healthy."
  },
  {
    "id": "investigate",
    "title": "Investigate",
    "summary": "Find out what happened or why, read-only and cited. A fix goes to Bug."
  },
  {
    "id": "analyze",
    "title": "Analyze",
    "summary": "Understand code and requirements, read-only, every claim cited."
  },
  {
    "id": "judge",
    "title": "Judge",
    "summary": "Get a verdict on a change, a risk or a choice, from a seat that did not make it."
  },
  {
    "id": "create",
    "title": "Create",
    "summary": "Documents, pages, demos and messages, grounded in your work."
  },
  {
    "id": "estimate",
    "title": "Estimate",
    "summary": "Estimate effort and price, and model what runs will cost."
  },
  {
    "id": "organize",
    "title": "Organize",
    "summary": "Turn requirements into a backlog, and set out who does what."
  },
  {
    "id": "improve",
    "title": "Improve",
    "summary": "Learn from your runs. Everything here is a proposal you approve."
  }
];

export const CATALOG_V2_CARDS: readonly CardSeedV2[] = [
  {
    "id": "plan-it",
    "category": "plan",
    "release": "1.0",
    "title": "Plan it",
    "archetype": "specify",
    "outcome": "A plan with its steps, risks and open questions, and each step as a job you can start.",
    "words": [
      "plan",
      "planning",
      "roadmap",
      "break down",
      "approach",
      "how should we",
      "work out",
      "scope",
      "strategy for",
      "steps to"
    ],
    "needs": [
      "nothing"
    ],
    "inputs": [
      "intent",
      "repo?",
      "project?",
      "seats"
    ],
    "delivers": "report",
    "gate": [
      "cited-findings"
    ],
    "seats": {
      "distinctEvaluator": true
    },
    "launch": {
      "kind": "run",
      "workflow": "plan"
    },
    "command": "/plan-it",
    "aliases": []
  },
  {
    "id": "feature",
    "category": "build",
    "release": "1.0",
    "title": "Build a feature",
    "archetype": "build",
    "outcome": "A pull request with the change, checked by tests and a review, after QE acceptance.",
    "words": [
      "build",
      "implement",
      "add",
      "new feature",
      "enhancement",
      "story",
      "support for",
      "endpoint",
      "screen",
      "option",
      "allow users"
    ],
    "needs": [
      "repo"
    ],
    "inputs": [
      "intent",
      "repo",
      "project?",
      "seats"
    ],
    "delivers": "pr",
    "gate": [
      "qe-acceptance"
    ],
    "seats": {
      "distinctEvaluator": true,
      "distinctJudge": true
    },
    "launch": {
      "kind": "run",
      "workflow": "feature"
    },
    "command": "/feature",
    "aliases": [
      {
        "command": "/workflow-feature",
        "option": null
      }
    ]
  },
  {
    "id": "bug",
    "category": "build",
    "release": "1.0",
    "title": "Fix a bug",
    "archetype": "build",
    "outcome": "A pull request with the fix and the checks that show it holds, after QE acceptance.",
    "words": [
      "bug",
      "fix",
      "broken",
      "error",
      "crash",
      "regression",
      "defect",
      "fails",
      "wrong result",
      "throws",
      "returns",
      "instead of",
      "exception"
    ],
    "needs": [
      "repo"
    ],
    "inputs": [
      "intent",
      "repo",
      "project?",
      "seats"
    ],
    "delivers": "pr",
    "gate": [
      "qe-acceptance"
    ],
    "seats": {
      "distinctEvaluator": true,
      "distinctJudge": true
    },
    "launch": {
      "kind": "run",
      "workflow": "bug"
    },
    "command": "/bug",
    "aliases": [
      {
        "command": "/workflow-bug",
        "option": null
      }
    ]
  },
  {
    "id": "migrate",
    "category": "build",
    "release": "1.0",
    "title": "Migrate or modernize",
    "archetype": "migrate",
    "outcome": "A planned move with a confirmed cutover, proof the new path behaves like the old one, and the old path removed.",
    "words": [
      "migrate",
      "migration",
      "modernize",
      "port",
      "move to",
      "move off",
      "replace",
      "cutover",
      "deprecate",
      "upgrade",
      "bump",
      "rewrite in",
      "legacy",
      "schema change",
      "backfill"
    ],
    "needs": [
      "repo"
    ],
    "inputs": [
      "intent",
      "repo",
      "project?",
      "seats"
    ],
    "delivers": "pr",
    "gate": [
      "qe-acceptance",
      "parity"
    ],
    "seats": {
      "distinctEvaluator": true,
      "distinctJudge": true
    },
    "command": "/migrate",
    "aliases": [
      {
        "command": "/workflow-migration",
        "option": "in-place"
      }
    ],
    "variant": {
      "axis": "kind",
      "label": "Kind of move",
      "default": "in-place",
      "options": [
        {
          "id": "move",
          "title": "Move",
          "summary": "Port to a new stack or platform; the old one is retired.",
          "archetype": "modernize",
          "words": [
            "port",
            "rewrite",
            "rewrite in",
            "move to",
            "move off",
            "new stack",
            "legacy",
            "modernize",
            "re-platform",
            "replatform",
            "cobol",
            "monolith"
          ],
          "launch": {
            "kind": "run",
            "workflow": "modernize"
          },
          "changesPlan": true,
          "requiresQe": true,
          "command": "/migrate move"
        },
        {
          "id": "in-place",
          "title": "In place",
          "summary": "Change a shape in place: a schema, an API, a library, with expand, cutover and contract.",
          "archetype": "migrate",
          "words": [
            "schema",
            "column",
            "table",
            "backfill",
            "rename",
            "api version",
            "replace library",
            "swap",
            "expand",
            "contract",
            "cutover",
            "deprecate",
            "breaking change"
          ],
          "launch": {
            "kind": "run",
            "workflow": "migration"
          },
          "changesPlan": false,
          "requiresQe": true,
          "command": "/migrate in-place"
        },
        {
          "id": "upgrade",
          "title": "Upgrade",
          "summary": "Move to a newer version of a dependency, framework or runtime.",
          "archetype": "migrate",
          "words": [
            "upgrade",
            "bump",
            "version",
            "major version",
            "node",
            "python",
            "java",
            "react",
            "angular",
            "spring",
            "dependency",
            "dependencies",
            "eol",
            "end of life",
            "to 22",
            "to 3"
          ],
          "launch": {
            "kind": "run",
            "workflow": "migration"
          },
          "brief": "Kind: upgrade. Move to the newer version named in the ask; the cutover is switching the pin, the cleanup removes compatibility shims.",
          "changesPlan": false,
          "requiresQe": true,
          "command": "/migrate upgrade"
        }
      ]
    }
  },
  {
    "id": "refactor",
    "category": "build",
    "release": "1.0",
    "title": "Refactor or polish",
    "archetype": "build",
    "outcome": "A pull request that restructures or tidies code with its behaviour unchanged, after QE acceptance.",
    "words": [
      "refactor",
      "restructure",
      "clean up",
      "cleanup",
      "tidy",
      "polish",
      "simplify",
      "extract",
      "split",
      "dead code",
      "rename",
      "lint",
      "tech debt",
      "duplication"
    ],
    "needs": [
      "repo"
    ],
    "inputs": [
      "intent",
      "repo",
      "project?",
      "seats"
    ],
    "delivers": "pr",
    "gate": [
      "qe-acceptance",
      "parity"
    ],
    "seats": {
      "distinctEvaluator": true,
      "distinctJudge": true
    },
    "command": "/refactor",
    "aliases": [],
    "variant": {
      "axis": "kind",
      "label": "Kind",
      "default": "refactor",
      "options": [
        {
          "id": "refactor",
          "title": "Refactor",
          "summary": "Restructure without changing behaviour.",
          "words": [
            "refactor",
            "restructure",
            "extract",
            "split",
            "simplify",
            "decouple",
            "duplication",
            "module"
          ],
          "launch": {
            "kind": "run",
            "workflow": "refactor"
          },
          "changesPlan": false,
          "requiresQe": true,
          "command": "/refactor refactor"
        },
        {
          "id": "polish",
          "title": "Polish",
          "summary": "Small quality fixes: naming, dead code, lint, small UI fixes.",
          "words": [
            "polish",
            "tidy",
            "lint",
            "dead code",
            "naming",
            "typos",
            "warnings",
            "spacing",
            "alignment"
          ],
          "launch": {
            "kind": "run",
            "workflow": "refactor"
          },
          "brief": "Kind: polish. Small, safe quality fixes only; no restructuring.",
          "changesPlan": false,
          "requiresQe": true,
          "command": "/refactor polish"
        }
      ]
    }
  },
  {
    "id": "release",
    "category": "build",
    "release": "1.0",
    "title": "Prepare a release",
    "archetype": "ship",
    "outcome": "A release pull request: versions bumped, changelog cut from what merged, and a GO or NO-GO readiness verdict.",
    "words": [
      "release",
      "cut a release",
      "ship",
      "version bump",
      "changelog",
      "tag",
      "release notes",
      "release candidate",
      "go no go",
      "publish"
    ],
    "needs": [
      "repo"
    ],
    "inputs": [
      "intent",
      "repo",
      "project?",
      "seats"
    ],
    "delivers": "pr",
    "gate": [
      "qe-acceptance",
      "fidelity-to-source"
    ],
    "seats": {
      "distinctEvaluator": true,
      "distinctJudge": true
    },
    "launch": {
      "kind": "run",
      "workflow": "release"
    },
    "command": "/release",
    "aliases": []
  },
  {
    "id": "start-new",
    "category": "build",
    "release": "1.0",
    "title": "Start something new",
    "archetype": "build",
    "outcome": "A new CLI, service, library or MCP server in a pull request, tested and reviewed; an MCP server is installed after your consent.",
    "words": [
      "new",
      "start",
      "scaffold",
      "bootstrap",
      "greenfield",
      "from scratch",
      "skeleton",
      "starter",
      "create a"
    ],
    "needs": [
      "repo"
    ],
    "inputs": [
      "intent",
      "repo",
      "project?",
      "seats"
    ],
    "delivers": "pr",
    "gate": [
      "qe-acceptance"
    ],
    "seats": {
      "distinctEvaluator": true,
      "distinctJudge": true
    },
    "command": "/new",
    "aliases": [
      {
        "command": "/workflow-mcp-server",
        "option": "mcp-server"
      }
    ],
    "variant": {
      "axis": "kind",
      "label": "What are you starting?",
      "default": "service",
      "options": [
        {
          "id": "cli",
          "title": "CLI",
          "summary": "A command-line tool.",
          "words": [
            "cli",
            "command line",
            "command-line",
            "terminal tool",
            "script",
            "subcommand"
          ],
          "launch": {
            "kind": "run",
            "workflow": "scaffold"
          },
          "brief": "Kind: CLI.",
          "changesPlan": false,
          "requiresQe": true,
          "command": "/new cli"
        },
        {
          "id": "service",
          "title": "Service",
          "summary": "An HTTP or worker service.",
          "words": [
            "service",
            "api",
            "microservice",
            "server",
            "backend",
            "worker",
            "endpoint",
            "rest"
          ],
          "launch": {
            "kind": "run",
            "workflow": "scaffold"
          },
          "brief": "Kind: service.",
          "changesPlan": false,
          "requiresQe": true,
          "command": "/new service"
        },
        {
          "id": "library",
          "title": "Library",
          "summary": "A package other code imports.",
          "words": [
            "library",
            "package",
            "sdk",
            "module",
            "npm package",
            "crate",
            "pip"
          ],
          "launch": {
            "kind": "run",
            "workflow": "scaffold"
          },
          "brief": "Kind: library.",
          "changesPlan": false,
          "requiresQe": true,
          "command": "/new library"
        },
        {
          "id": "mcp-server",
          "title": "MCP server",
          "summary": "Tools for agents, installed after your consent.",
          "words": [
            "mcp",
            "mcp server",
            "tools for agents",
            "agent tool",
            "connector",
            "integration",
            "give agents"
          ],
          "launch": {
            "kind": "run",
            "workflow": "mcp-server"
          },
          "changesPlan": true,
          "requiresQe": true,
          "command": "/new mcp"
        }
      ]
    }
  },
  {
    "id": "studio-plugin",
    "category": "build",
    "release": "1.0",
    "title": "Studio plugin",
    "archetype": "build",
    "outcome": "A studio plugin designed, built, tested and installed after your consent: an editor, or a section in every job's details.",
    "words": [
      "plugin",
      "studio plugin",
      "editor",
      "viewer",
      "file type",
      "extension",
      "phase plugin",
      "job details",
      "details section"
    ],
    "needs": [
      "repo"
    ],
    "inputs": [
      "intent",
      "repo",
      "project?",
      "seats"
    ],
    "delivers": "pr",
    "gate": [
      "qe-acceptance"
    ],
    "seats": {
      "distinctEvaluator": true,
      "distinctJudge": true
    },
    "command": "/plugin",
    "aliases": [
      {
        "command": "/workflow-editor-plugin",
        "option": "editor"
      }
    ],
    "variant": {
      "axis": "kind",
      "label": "Kind of plugin",
      "default": "editor",
      "options": [
        {
          "id": "editor",
          "title": "Editor",
          "summary": "Edit a kind of file in studio.",
          "words": [
            "editor",
            "viewer",
            "file type",
            "edit",
            "open in studio"
          ],
          "launch": {
            "kind": "run",
            "workflow": "editor-plugin"
          },
          "changesPlan": false,
          "requiresQe": true,
          "command": "/plugin editor"
        },
        {
          "id": "phase",
          "title": "Phase",
          "summary": "A section in every job's details, drawn from its events.",
          "words": [
            "phase plugin",
            "phase",
            "section",
            "job details",
            "each phase",
            "elapsed time"
          ],
          "launch": {
            "kind": "run",
            "workflow": "editor-plugin"
          },
          "brief": "Kind: phase plugin.",
          "changesPlan": true,
          "requiresQe": true,
          "command": "/plugin phase"
        }
      ]
    }
  },
  {
    "id": "plan-tests",
    "category": "test",
    "release": "1.0",
    "title": "Plan tests",
    "archetype": "specify",
    "outcome": "The test gaps in the code, then a risk-ranked test plan file in a pull request, ready to automate.",
    "words": [
      "test plan",
      "test strategy",
      "what to test",
      "scenarios",
      "qa plan",
      "test gaps",
      "coverage",
      "untested",
      "under-tested",
      "test coverage"
    ],
    "needs": [
      "repo"
    ],
    "inputs": [
      "intent",
      "repo",
      "project?",
      "seats"
    ],
    "delivers": "pr",
    "gate": [
      "cited-findings"
    ],
    "seats": {
      "distinctEvaluator": true
    },
    "launch": {
      "kind": "run",
      "workflow": "test-plan"
    },
    "command": "/plan-tests",
    "aliases": [
      {
        "command": "/workflow-test-plan",
        "option": null
      }
    ]
  },
  {
    "id": "test-analysis",
    "category": "test",
    "release": "1.0",
    "title": "Test analysis (the gaps only)",
    "archetype": "specify",
    "outcome": "The existing test-analysis workflow, unchanged: the test gaps, without the plan.",
    "words": [],
    "hidden": true,
    "needs": [
      "repo"
    ],
    "inputs": [
      "intent",
      "repo",
      "project?",
      "seats"
    ],
    "delivers": "report",
    "gate": [],
    "launch": {
      "kind": "run",
      "workflow": "test-analysis"
    },
    "aliases": [
      {
        "command": "/workflow-test-analysis",
        "option": null
      }
    ],
    "command": null
  },
  {
    "id": "write-tests",
    "category": "test",
    "release": "1.0",
    "title": "Write and run tests",
    "archetype": "build",
    "outcome": "A pull request with behaviour tests that ran green under your own test setup.",
    "words": [
      "write tests",
      "add tests",
      "unit tests",
      "e2e",
      "integration tests",
      "test automation",
      "automate tests",
      "cover with tests"
    ],
    "needs": [
      "repo"
    ],
    "inputs": [
      "intent",
      "repo",
      "project?",
      "seats"
    ],
    "delivers": "pr",
    "gate": [
      "evidence-floor"
    ],
    "seats": {
      "distinctEvaluator": true
    },
    "launch": {
      "kind": "run",
      "workflow": "qe-author-tests"
    },
    "command": "/write-tests",
    "aliases": [
      {
        "command": "/workflow-qe-author-tests",
        "option": null
      }
    ]
  },
  {
    "id": "suite-health",
    "category": "test",
    "release": "1.0",
    "title": "Keep the suite healthy",
    "archetype": "build",
    "outcome": "A pull request that fixes flaky, weak, rotten or slow tests, with the suite run green under your own setup.",
    "words": [
      "flaky",
      "flake",
      "flakes",
      "intermittent",
      "slow tests",
      "snapshot",
      "snapshots",
      "weak tests",
      "test smells",
      "assertion-free",
      "test suite",
      "test health",
      "quarantine"
    ],
    "needs": [
      "repo"
    ],
    "inputs": [
      "intent",
      "repo",
      "project?",
      "seats"
    ],
    "delivers": "pr",
    "gate": [
      "cited-findings",
      "evidence-floor"
    ],
    "seats": {
      "distinctEvaluator": true
    },
    "command": "/suite-health",
    "aliases": [],
    "variant": {
      "axis": "kind",
      "label": "What needs attention?",
      "default": "flaky",
      "options": [
        {
          "id": "flaky",
          "title": "Flaky",
          "words": [
            "flaky",
            "flake",
            "intermittent",
            "random failures",
            "sometimes fails",
            "retry"
          ],
          "launch": {
            "kind": "run",
            "workflow": "suite-health"
          },
          "brief": "Focus: flaky tests.",
          "changesPlan": false,
          "command": "/suite-health flaky"
        },
        {
          "id": "weak",
          "title": "Weak",
          "words": [
            "weak",
            "assertion",
            "tautological",
            "smells",
            "empty tests",
            "mocks everything"
          ],
          "launch": {
            "kind": "run",
            "workflow": "suite-health"
          },
          "brief": "Focus: weak or empty tests.",
          "changesPlan": false,
          "command": "/suite-health weak"
        },
        {
          "id": "snapshots",
          "title": "Snapshots",
          "words": [
            "snapshot",
            "snapshots",
            "golden",
            "cassettes",
            "stale snapshots"
          ],
          "launch": {
            "kind": "run",
            "workflow": "suite-health"
          },
          "brief": "Focus: snapshot rot.",
          "changesPlan": false,
          "command": "/suite-health snapshots"
        },
        {
          "id": "slow",
          "title": "Slow",
          "words": [
            "slow",
            "takes forever",
            "minutes",
            "speed up",
            "too long",
            "parallel"
          ],
          "launch": {
            "kind": "run",
            "workflow": "suite-health"
          },
          "brief": "Focus: slow tests.",
          "changesPlan": false,
          "command": "/suite-health slow"
        }
      ]
    }
  },
  {
    "id": "incident",
    "category": "investigate",
    "release": "1.0",
    "title": "Incident or root cause",
    "archetype": "incident",
    "outcome": "What broke and why, each cause cited to a code or log line, with the fix handed to Bug.",
    "words": [
      "incident",
      "outage",
      "down",
      "root cause",
      "rca",
      "post-mortem",
      "postmortem",
      "why did",
      "paged",
      "5xx",
      "spike",
      "error rate",
      "sev",
      "quick look",
      "deep dive",
      "thorough"
    ],
    "depth": true,
    "needs": [
      "nothing"
    ],
    "inputs": [
      "intent",
      "repo?",
      "sources?",
      "project?",
      "seats",
      "depth"
    ],
    "delivers": "report",
    "gate": [
      "cited-findings"
    ],
    "seats": {
      "distinctEvaluator": true
    },
    "launch": {
      "kind": "run",
      "workflow": "investigate-incident"
    },
    "handoff": {
      "card": "bug",
      "option": null
    },
    "command": "/incident",
    "aliases": []
  },
  {
    "id": "competitive",
    "category": "investigate",
    "release": "1.0",
    "title": "Competitive or market analysis",
    "archetype": "explore",
    "outcome": "How others do it, with every claim cited to a source.",
    "words": [
      "competitor",
      "competitive",
      "market",
      "landscape",
      "alternatives",
      "vendors",
      "who else"
    ],
    "depth": true,
    "needs": [
      "nothing"
    ],
    "inputs": [
      "intent",
      "sources",
      "project?",
      "seats",
      "depth"
    ],
    "delivers": "report",
    "gate": [
      "fidelity-to-source"
    ],
    "seats": {
      "distinctEvaluator": true
    },
    "launch": {
      "kind": "run",
      "workflow": "sourced-report"
    },
    "brief": "Lens: competitive.",
    "command": "/competitive",
    "aliases": []
  },
  {
    "id": "due-diligence",
    "category": "investigate",
    "release": "1.0",
    "title": "Due diligence",
    "archetype": "review",
    "outcome": "A cited review of a target's documents: what holds, what is missing, what is a risk.",
    "words": [
      "due diligence",
      "diligence",
      "data room",
      "vendor assessment",
      "acquisition",
      "evaluate a vendor"
    ],
    "depth": true,
    "needs": [
      "documents"
    ],
    "inputs": [
      "documents",
      "intent?",
      "sources?",
      "project?",
      "seats",
      "depth"
    ],
    "delivers": "report",
    "gate": [
      "fidelity-to-source"
    ],
    "seats": {
      "distinctEvaluator": true
    },
    "launch": {
      "kind": "run",
      "workflow": "sourced-report"
    },
    "brief": "Lens: due-diligence.",
    "command": "/due-diligence",
    "aliases": []
  },
  {
    "id": "research",
    "category": "investigate",
    "release": "1.0",
    "title": "Research a question",
    "archetype": "explore",
    "outcome": "A cited answer from outside sources.",
    "words": [
      "research",
      "find out",
      "look into",
      "what is the best",
      "state of the art",
      "read up"
    ],
    "depth": true,
    "needs": [
      "nothing"
    ],
    "inputs": [
      "intent",
      "sources",
      "project?",
      "seats",
      "depth"
    ],
    "delivers": "report",
    "gate": [
      "fidelity-to-source"
    ],
    "seats": {
      "distinctEvaluator": true
    },
    "launch": {
      "kind": "run",
      "workflow": "sourced-report"
    },
    "brief": "Lens: research.",
    "command": "/find-out",
    "aliases": []
  },
  {
    "id": "reconstruct",
    "category": "investigate",
    "release": "1.0",
    "title": "Reconstruct what happened",
    "archetype": "review",
    "outcome": "A timeline of what changed and why, each event cited to a commit, pull request or run.",
    "words": [
      "what happened",
      "reconstruct",
      "timeline",
      "history",
      "who changed",
      "when did",
      "why did this change",
      "blame",
      "how did we get here",
      "sequence of events"
    ],
    "depth": true,
    "needs": [
      "repo"
    ],
    "inputs": [
      "intent",
      "repo",
      "project?",
      "seats",
      "depth"
    ],
    "delivers": "report",
    "gate": [
      "cited-findings"
    ],
    "seats": {
      "distinctEvaluator": true
    },
    "launch": {
      "kind": "run",
      "workflow": "reconstruct"
    },
    "handoff": {
      "card": "bug",
      "option": null
    },
    "command": "/reconstruct",
    "aliases": []
  },
  {
    "id": "analyze-codebase",
    "category": "analyze",
    "release": "1.0",
    "title": "Analyze a codebase",
    "archetype": "explore",
    "outcome": "A cited account of the code: how it works, what it does as requirements, or where its docs are wrong.",
    "words": [
      "analyze",
      "understand",
      "explain",
      "how does",
      "how it works",
      "architecture",
      "overview",
      "walk me through",
      "map the domain",
      "requirements from code",
      "docs drift",
      "check docs",
      "stale docs"
    ],
    "needs": [
      "repo"
    ],
    "inputs": [
      "intent?",
      "repo",
      "project?",
      "seats"
    ],
    "delivers": "report",
    "gate": [
      "cited-findings"
    ],
    "seats": {
      "distinctEvaluator": true
    },
    "command": "/analyze",
    "aliases": [
      {
        "command": "/workflow-domain-extraction",
        "option": "domain"
      },
      {
        "command": "/workflow-validate-docs",
        "option": "docs"
      }
    ],
    "variant": {
      "axis": "lens",
      "label": "Lens",
      "default": "overview",
      "options": [
        {
          "id": "overview",
          "title": "How it works",
          "summary": "Architecture and flows, cited (search narrate/service-map; engineering arch action).",
          "words": [
            "how does",
            "how it works",
            "architecture",
            "overview",
            "explain",
            "walk me through",
            "structure",
            "flow"
          ],
          "launch": {
            "kind": "run",
            "workflow": "analyze-codebase"
          },
          "changesPlan": false,
          "writes": "nothing",
          "command": "/analyze overview"
        },
        {
          "id": "domain",
          "title": "Domain",
          "summary": "What the code does as requirements, with coverage. Writes its requirements map to the project graph, never the repository.",
          "words": [
            "domain",
            "business rules",
            "requirements from code",
            "reverse engineer",
            "what does it do",
            "map the domain",
            "extract rules"
          ],
          "launch": {
            "kind": "run",
            "workflow": "domain-extraction"
          },
          "changesPlan": true,
          "inputs": [
            "intent?",
            "repo",
            "project",
            "seats"
          ],
          "writes": "domain-artifacts",
          "command": "/analyze domain"
        },
        {
          "id": "docs",
          "title": "Docs vs code",
          "summary": "Every wrong or stale claim in the docs.",
          "words": [
            "docs",
            "readme",
            "documentation",
            "stale",
            "drift",
            "out of date",
            "fact check",
            "are the docs"
          ],
          "launch": {
            "kind": "run",
            "workflow": "validate-docs"
          },
          "changesPlan": true,
          "writes": "nothing",
          "command": "/analyze docs"
        }
      ]
    }
  },
  {
    "id": "map-requirements",
    "category": "analyze",
    "release": "1.0",
    "title": "Map requirements",
    "archetype": "specify",
    "outcome": "Each requirement you pick traced to the code that meets it, or marked unmet, cited.",
    "words": [
      "traceability",
      "trace requirements",
      "requirements coverage",
      "which requirements",
      "satisfied by",
      "acceptance criteria met",
      "map requirements",
      "rtm"
    ],
    "needs": [
      "repo",
      "project",
      "requirements"
    ],
    "inputs": [
      "repo",
      "project",
      "requirements",
      "seats"
    ],
    "delivers": "report",
    "gate": [
      "cited-findings"
    ],
    "seats": {
      "distinctEvaluator": true
    },
    "launch": {
      "kind": "run",
      "workflow": "map-requirements"
    },
    "command": "/requirements",
    "aliases": []
  },
  {
    "id": "analyze-documents",
    "category": "analyze",
    "release": "1.0",
    "title": "Analyze documents",
    "archetype": "explore",
    "outcome": "What a set of documents says, compared and cited to the page.",
    "words": [
      "analyze documents",
      "summarize these",
      "compare documents",
      "contracts",
      "pdfs",
      "spreadsheet"
    ],
    "needs": [
      "documents"
    ],
    "inputs": [
      "documents",
      "intent?",
      "sources?",
      "seats"
    ],
    "delivers": "report",
    "gate": [
      "fidelity-to-source"
    ],
    "seats": {
      "distinctEvaluator": true
    },
    "launch": {
      "kind": "run",
      "workflow": "sourced-report"
    },
    "brief": "Lens: analyze.",
    "command": "/analyze-docs",
    "aliases": []
  },
  {
    "id": "review-change",
    "category": "judge",
    "release": "1.0",
    "title": "Review a change",
    "archetype": "review",
    "outcome": "A verdict on a pull request or branch: approve, conditional or reject, with every finding cited.",
    "words": [
      "review",
      "code review",
      "review pr",
      "pull request",
      "look at this pr",
      "pr",
      "diff",
      "branch",
      "second opinion",
      "approve"
    ],
    "needs": [
      "repo"
    ],
    "inputs": [
      "intent",
      "repo",
      "project?",
      "seats"
    ],
    "delivers": "report",
    "gate": [
      "cited-findings"
    ],
    "seats": {
      "distinctEvaluator": true,
      "excludeChangeAuthors": true
    },
    "launch": {
      "kind": "run",
      "workflow": "review-change"
    },
    "command": "/review-change",
    "aliases": []
  },
  {
    "id": "critique",
    "category": "judge",
    "release": "1.0",
    "title": "Critique a document, proposal or claim",
    "archetype": "review",
    "outcome": "Where an argument holds and where it does not, cited to the page.",
    "words": [
      "critique",
      "poke holes",
      "red team",
      "challenge",
      "is this right",
      "review this proposal",
      "feedback on"
    ],
    "needs": [
      "nothing"
    ],
    "inputs": [
      "intent",
      "documents?",
      "sources?",
      "seats"
    ],
    "delivers": "report",
    "gate": [
      "fidelity-to-source"
    ],
    "seats": {
      "distinctEvaluator": true
    },
    "launch": {
      "kind": "run",
      "workflow": "sourced-report"
    },
    "brief": "Lens: critique.",
    "command": "/critique-doc",
    "aliases": []
  },
  {
    "id": "risk",
    "category": "judge",
    "release": "1.0",
    "title": "Risk analysis",
    "archetype": "review",
    "outcome": "A risk matrix for a change or an area: failure modes, likelihood, impact and mitigations, cited.",
    "words": [
      "risk",
      "risks",
      "risky",
      "failure modes",
      "what could go wrong",
      "blast radius",
      "impact",
      "fmea",
      "mitigations"
    ],
    "needs": [
      "repo"
    ],
    "inputs": [
      "intent",
      "repo",
      "project?",
      "seats"
    ],
    "delivers": "report",
    "gate": [
      "cited-findings"
    ],
    "seats": {
      "distinctEvaluator": true
    },
    "launch": {
      "kind": "run",
      "workflow": "risk-analysis"
    },
    "command": "/risk",
    "aliases": []
  },
  {
    "id": "security",
    "category": "judge",
    "release": "1.0",
    "title": "Security and compliance review",
    "archetype": "review",
    "outcome": "Security, privacy or compliance findings, each cited to code, with the fix to make.",
    "words": [
      "security",
      "vulnerability",
      "owasp",
      "secrets",
      "pentest",
      "privacy",
      "pii",
      "gdpr",
      "hipaa",
      "soc2",
      "soc 2",
      "pci",
      "compliance",
      "audit"
    ],
    "needs": [
      "repo"
    ],
    "inputs": [
      "intent",
      "repo",
      "project?",
      "seats"
    ],
    "delivers": "report",
    "gate": [
      "cited-findings"
    ],
    "seats": {
      "distinctEvaluator": true
    },
    "command": "/audit",
    "aliases": [],
    "variant": {
      "axis": "kind",
      "label": "Kind of review",
      "default": "security",
      "options": [
        {
          "id": "security",
          "title": "Security",
          "words": [
            "security",
            "vulnerability",
            "vulnerabilities",
            "owasp",
            "secrets",
            "injection",
            "auth",
            "pentest",
            "cve"
          ],
          "launch": {
            "kind": "run",
            "workflow": "security-review"
          },
          "changesPlan": false,
          "command": "/audit security"
        },
        {
          "id": "privacy",
          "title": "Privacy",
          "words": [
            "privacy",
            "pii",
            "phi",
            "personal data",
            "gdpr",
            "data protection"
          ],
          "launch": {
            "kind": "run",
            "workflow": "privacy-review"
          },
          "changesPlan": true,
          "command": "/audit privacy"
        },
        {
          "id": "compliance",
          "title": "Compliance",
          "words": [
            "compliance",
            "soc2",
            "soc 2",
            "hipaa",
            "pci",
            "controls",
            "regulatory",
            "audit"
          ],
          "launch": {
            "kind": "run",
            "workflow": "compliance-review"
          },
          "changesPlan": true,
          "command": "/audit compliance"
        }
      ]
    }
  },
  {
    "id": "decide",
    "category": "judge",
    "release": "1.0",
    "title": "Decide (ADR)",
    "archetype": "decide",
    "outcome": "Options scored by seats that did not write them, and your pick; the ADR is then written by Document · Docs in the repo, filled in.",
    "words": [
      "decide",
      "decision",
      "adr",
      "should we use",
      "which",
      "or",
      "trade-off",
      "tradeoff",
      "choose between",
      "pick between",
      "versus",
      "vs"
    ],
    "needs": [
      "nothing"
    ],
    "inputs": [
      "intent",
      "repo?",
      "project?",
      "seats"
    ],
    "delivers": "report",
    "gate": [
      "cited-findings",
      "pick"
    ],
    "seats": {
      "distinctEvaluator": true,
      "council": false
    },
    "launch": {
      "kind": "run",
      "workflow": "decide"
    },
    "handoff": {
      "card": "document",
      "option": "repo-docs"
    },
    "command": "/decide",
    "aliases": []
  },
  {
    "id": "document",
    "category": "create",
    "release": "1.0",
    "title": "Document",
    "outcome": "A document, a deck or Markdown docs in your repository, grounded in your work.",
    "words": [
      "document",
      "doc",
      "write up",
      "memo",
      "white paper",
      "report",
      "proposal",
      "deck",
      "slides",
      "presentation",
      "readme",
      "docs",
      "guide",
      "api reference",
      "pdf"
    ],
    "needs": [
      "project"
    ],
    "inputs": [
      "intent",
      "project",
      "repo?",
      "seats"
    ],
    "delivers": "document",
    "gate": [
      "draft-floor"
    ],
    "seats": {},
    "command": "/document",
    "aliases": [
      {
        "command": "/workflow-docs",
        "option": "repo-docs"
      }
    ],
    "variant": {
      "axis": "docStyle",
      "label": "Style",
      "default": "document",
      "options": [
        {
          "id": "document",
          "title": "Document",
          "summary": "Prose you edit in studio and export as PDF.",
          "words": [
            "memo",
            "white paper",
            "write up",
            "report",
            "pdf",
            "word",
            "docx",
            "document",
            "brief"
          ],
          "launch": {
            "kind": "document",
            "style": "doc"
          },
          "changesPlan": false,
          "gate": [
            "draft-floor"
          ],
          "command": "/document doc"
        },
        {
          "id": "presentation",
          "title": "Presentation",
          "summary": "16:9 slides you edit in studio.",
          "words": [
            "deck",
            "slides",
            "slide deck",
            "presentation",
            "pitch",
            "keynote",
            "powerpoint",
            "pptx"
          ],
          "launch": {
            "kind": "document",
            "style": "ppt"
          },
          "changesPlan": true,
          "gate": [
            "draft-floor"
          ],
          "command": "/document deck"
        },
        {
          "id": "repo-docs",
          "title": "Docs in the repo",
          "summary": "Markdown in your repository, every claim checked against the code, as a pull request.",
          "words": [
            "readme",
            "docs",
            "documentation",
            "guide",
            "api reference",
            "markdown",
            "md",
            "contributing"
          ],
          "launch": {
            "kind": "run",
            "workflow": "docs"
          },
          "changesPlan": true,
          "inputs": [
            "intent",
            "repo",
            "project?",
            "seats"
          ],
          "needs": [
            "repo"
          ],
          "delivers": "pr",
          "gate": [
            "fidelity-to-source"
          ],
          "seats": {
            "distinctEvaluator": true
          },
          "command": "/document repo"
        }
      ]
    }
  },
  {
    "id": "interactive-page",
    "category": "create",
    "release": "1.0",
    "title": "Interactive page",
    "outcome": "A versioned web page document in studio that you can edit in place and export as PDF.",
    "words": [
      "web page",
      "html",
      "interactive",
      "explainer",
      "one pager",
      "living spec",
      "page",
      "microsite"
    ],
    "needs": [
      "project"
    ],
    "inputs": [
      "intent",
      "project",
      "repo?",
      "seats"
    ],
    "delivers": "document",
    "gate": [
      "draft-floor"
    ],
    "launch": {
      "kind": "document",
      "style": "web"
    },
    "command": "/page",
    "aliases": []
  },
  {
    "id": "demo-video",
    "category": "create",
    "release": "1.0",
    "title": "Demo video",
    "outcome": "A captioned video of your app, recorded and reviewed by a second seat.",
    "words": [
      "video",
      "demo",
      "screencast",
      "recording",
      "walkthrough video",
      "record"
    ],
    "needs": [
      "project",
      "running_app"
    ],
    "inputs": [
      "project",
      "url",
      "audience",
      "show"
    ],
    "delivers": "video",
    "gate": [
      "walkthrough"
    ],
    "seats": {
      "distinctEvaluator": true
    },
    "launch": {
      "kind": "demo"
    },
    "command": "/demo",
    "aliases": []
  },
  {
    "id": "app",
    "category": "create",
    "release": "as-is",
    "title": "App",
    "outcome": "Live apps and dashboards over your APIs and databases.",
    "words": [
      "app",
      "dashboard",
      "internal tool",
      "data app"
    ],
    "launch": {
      "kind": "app"
    },
    "command": null,
    "aliases": []
  },
  {
    "id": "respond",
    "category": "create",
    "release": "1.0",
    "title": "Respond to an ask",
    "outcome": "A response to an RFP, RFI or questionnaire, every answer traced to its source.",
    "words": [
      "rfp",
      "rfi",
      "questionnaire",
      "tender",
      "bid",
      "security questionnaire",
      "respond to"
    ],
    "needs": [
      "documents"
    ],
    "inputs": [
      "documents",
      "intent?",
      "project?",
      "seats"
    ],
    "delivers": "document",
    "gate": [
      "fidelity-to-source"
    ],
    "seats": {
      "distinctEvaluator": true
    },
    "command": "/respond",
    "aliases": [],
    "variant": {
      "axis": "kind",
      "label": "Kind of ask",
      "default": "rfp",
      "options": [
        {
          "id": "rfp",
          "title": "RFP",
          "summary": "A response to a request for proposal.",
          "words": [
            "rfp",
            "request for proposal",
            "tender",
            "bid",
            "proposal response"
          ],
          "launch": {
            "kind": "document",
            "style": "doc"
          },
          "brief": "Kind: respond-rfp.",
          "changesPlan": false,
          "command": "/respond rfp"
        },
        {
          "id": "rfi",
          "title": "RFI",
          "summary": "Answers to a request for information.",
          "words": [
            "rfi",
            "request for information",
            "information request"
          ],
          "launch": {
            "kind": "document",
            "style": "doc"
          },
          "brief": "Kind: respond-rfi.",
          "changesPlan": false,
          "command": "/respond rfi"
        },
        {
          "id": "questionnaire",
          "title": "Questionnaire",
          "summary": "A filled-in questionnaire.",
          "words": [
            "questionnaire",
            "security questionnaire",
            "vendor questionnaire",
            "fill in"
          ],
          "launch": {
            "kind": "document",
            "style": "doc"
          },
          "brief": "Kind: respond-questionnaire.",
          "changesPlan": false,
          "command": "/respond questionnaire"
        }
      ]
    }
  },
  {
    "id": "rework",
    "category": "create",
    "release": "1.0",
    "title": "Rework an artifact",
    "outcome": "An artifact condensed, re-aimed, generalized, converted or refreshed, faithful to its source.",
    "words": [
      "condense",
      "shorten",
      "re-audience",
      "rewrite for",
      "generalize",
      "convert",
      "refresh",
      "update this deck",
      "turn this into"
    ],
    "needs": [
      "documents"
    ],
    "inputs": [
      "documents",
      "intent?",
      "project?",
      "seats"
    ],
    "delivers": "document",
    "gate": [
      "fidelity-to-source"
    ],
    "seats": {
      "distinctEvaluator": true
    },
    "command": "/rework",
    "aliases": [],
    "variant": {
      "axis": "kind",
      "label": "Kind of rework",
      "default": "condense",
      "options": [
        {
          "id": "condense",
          "title": "Condense",
          "summary": "Shorter, saying nothing new.",
          "words": [
            "condense",
            "shorten",
            "summary of",
            "exec summary",
            "one-page",
            "shorter version"
          ],
          "launch": {
            "kind": "document",
            "style": "doc"
          },
          "brief": "Kind: rework-condense.",
          "changesPlan": false,
          "command": "/rework condense"
        },
        {
          "id": "re-audience",
          "title": "Re-audience",
          "summary": "The same content for another audience.",
          "words": [
            "re-audience",
            "rewrite for",
            "for engineers",
            "for executives",
            "for customers"
          ],
          "launch": {
            "kind": "document",
            "style": "doc"
          },
          "brief": "Kind: rework-re-audience.",
          "changesPlan": false,
          "command": "/rework re-audience"
        },
        {
          "id": "generalize",
          "title": "Generalize",
          "summary": "Reusable, with the specifics taken out.",
          "words": [
            "generalize",
            "template from",
            "make it reusable",
            "anonymize"
          ],
          "launch": {
            "kind": "document",
            "style": "doc"
          },
          "brief": "Kind: rework-generalize.",
          "changesPlan": false,
          "command": "/rework generalize"
        },
        {
          "id": "convert",
          "title": "Convert",
          "summary": "The same content as slides.",
          "words": [
            "convert",
            "as a deck",
            "into slides",
            "slide deck from",
            "turn this into slides"
          ],
          "launch": {
            "kind": "document",
            "style": "ppt"
          },
          "brief": "Kind: rework-convert.",
          "changesPlan": false,
          "command": "/rework convert"
        },
        {
          "id": "refresh",
          "title": "Refresh",
          "summary": "Updated from newer sources.",
          "words": [
            "refresh",
            "bring up to date",
            "latest numbers",
            "update with"
          ],
          "launch": {
            "kind": "document",
            "style": "doc"
          },
          "brief": "Kind: rework-refresh.",
          "changesPlan": false,
          "command": "/rework refresh"
        }
      ]
    }
  },
  {
    "id": "communicate",
    "category": "create",
    "release": "1.0",
    "title": "Communicate",
    "outcome": "A narrative, meeting prep, demo script, status update or message, grounded in your work.",
    "words": [
      "status update",
      "update",
      "email",
      "message",
      "announcement",
      "narrative",
      "story",
      "meeting prep",
      "talking points",
      "demo script",
      "summary for",
      "write to",
      "slack"
    ],
    "needs": [
      "project"
    ],
    "inputs": [
      "intent",
      "project",
      "repo?",
      "seats"
    ],
    "delivers": "document",
    "gate": [
      "draft-floor"
    ],
    "command": "/communicate",
    "aliases": [],
    "variant": {
      "axis": "kind",
      "label": "Kind",
      "default": "message",
      "options": [
        {
          "id": "narrative",
          "title": "Narrative",
          "words": [
            "narrative",
            "story",
            "storyline",
            "why we"
          ],
          "launch": {
            "kind": "document",
            "style": "doc"
          },
          "brief": "Kind: narrative.",
          "changesPlan": false,
          "command": "/communicate narrative"
        },
        {
          "id": "meeting-prep",
          "title": "Meeting prep",
          "words": [
            "meeting",
            "meeting prep",
            "talking points",
            "agenda",
            "prep for",
            "briefing"
          ],
          "launch": {
            "kind": "document",
            "style": "doc"
          },
          "brief": "Kind: meeting prep.",
          "changesPlan": false,
          "command": "/communicate meeting"
        },
        {
          "id": "demo-script",
          "title": "Demo script",
          "words": [
            "demo script",
            "script for the demo",
            "run of show"
          ],
          "launch": {
            "kind": "document",
            "style": "doc"
          },
          "brief": "Kind: demo script.",
          "changesPlan": false,
          "command": "/communicate demo-script"
        },
        {
          "id": "status-update",
          "title": "Status update",
          "words": [
            "status",
            "status update",
            "weekly update",
            "progress",
            "where are we",
            "report out"
          ],
          "launch": {
            "kind": "document",
            "style": "doc"
          },
          "brief": "Kind: status update.",
          "changesPlan": false,
          "command": "/communicate status"
        },
        {
          "id": "message",
          "title": "Message",
          "words": [
            "email",
            "message",
            "slack",
            "announcement",
            "note to",
            "reply"
          ],
          "launch": {
            "kind": "document",
            "style": "doc"
          },
          "brief": "Kind: message.",
          "changesPlan": false,
          "command": "/communicate message"
        }
      ]
    }
  },
  {
    "id": "estimate-price",
    "category": "estimate",
    "release": "1.0",
    "title": "Estimate and price",
    "outcome": "Effort and price from a scope document, with the assumptions named.",
    "words": [
      "estimate",
      "estimation",
      "how long",
      "effort",
      "pricing",
      "price",
      "quote",
      "sizing",
      "cost of the work"
    ],
    "needs": [
      "nothing"
    ],
    "inputs": [
      "intent",
      "documents?",
      "sources?",
      "repo?",
      "seats"
    ],
    "delivers": "report",
    "gate": [
      "fidelity-to-source"
    ],
    "seats": {
      "distinctEvaluator": true
    },
    "launch": {
      "kind": "run",
      "workflow": "sourced-report"
    },
    "brief": "Lens: estimate.",
    "command": "/estimate",
    "aliases": []
  },
  {
    "id": "run-cost",
    "category": "estimate",
    "release": "1.0",
    "title": "Model run cost",
    "outcome": "What a volume of work will cost to run, from your own comparable runs, with every assumption named.",
    "words": [
      "run cost",
      "token cost",
      "how much will it cost to run",
      "spend",
      "budget for runs"
    ],
    "needs": [
      "runs"
    ],
    "inputs": [
      "intent",
      "documents?",
      "project?",
      "seats"
    ],
    "delivers": "report",
    "gate": [
      "fidelity-to-source"
    ],
    "seats": {
      "distinctEvaluator": true
    },
    "launch": {
      "kind": "run",
      "workflow": "run-cost"
    },
    "command": "/run-cost",
    "aliases": []
  },
  {
    "id": "backlog",
    "category": "organize",
    "release": "1.0",
    "title": "Backlog from requirements",
    "archetype": "specify",
    "outcome": "Epics, stories and tasks drafted from the requirements you pick, each traced to its requirement.",
    "words": [
      "backlog",
      "epics",
      "stories",
      "user stories",
      "tasks",
      "tickets",
      "break into stories",
      "jira tickets"
    ],
    "needs": [
      "project",
      "requirements"
    ],
    "inputs": [
      "project",
      "requirements"
    ],
    "delivers": "document",
    "gate": [
      "traces-to-requirements"
    ],
    "command": "/backlog",
    "aliases": [],
    "variant": {
      "axis": "kind",
      "label": "Down to",
      "default": "stories",
      "options": [
        {
          "id": "epics",
          "title": "Epics",
          "words": [
            "epics",
            "epic"
          ],
          "launch": {
            "kind": "compose"
          },
          "compose": {
            "level": "epics"
          },
          "changesPlan": true,
          "command": "/backlog epics"
        },
        {
          "id": "stories",
          "title": "Stories",
          "words": [
            "stories",
            "user stories",
            "story"
          ],
          "launch": {
            "kind": "compose"
          },
          "compose": {
            "level": "stories"
          },
          "changesPlan": false,
          "command": "/backlog stories"
        },
        {
          "id": "tasks",
          "title": "Tasks",
          "words": [
            "tasks",
            "subtasks",
            "tickets"
          ],
          "launch": {
            "kind": "compose"
          },
          "compose": {
            "level": "tasks"
          },
          "changesPlan": true,
          "command": "/backlog tasks"
        }
      ]
    }
  },
  {
    "id": "operating-model",
    "category": "organize",
    "release": "1.0",
    "title": "Roles and operating model",
    "outcome": "Who does what: roles, responsibilities, decision rights and cadences, as a document.",
    "words": [
      "roles",
      "raci",
      "operating model",
      "responsibilities",
      "who does what",
      "team structure",
      "org",
      "ways of working",
      "cadence",
      "governance model"
    ],
    "needs": [
      "project"
    ],
    "inputs": [
      "intent",
      "project",
      "repo?",
      "seats"
    ],
    "delivers": "document",
    "gate": [
      "draft-floor"
    ],
    "launch": {
      "kind": "document",
      "style": "doc"
    },
    "brief": "Kind: operating model.",
    "command": "/roles",
    "aliases": []
  },
  {
    "id": "setup-project",
    "category": "organize",
    "release": "deferred",
    "title": "Set up a project",
    "words": [
      "set up a project",
      "new project",
      "onboard"
    ],
    "launch": {
      "kind": "none"
    },
    "status": "coming_soon",
    "statusNote": "Deferred: setting up a project is the Projects page and its guided first run, not a job.",
    "command": null,
    "aliases": []
  },
  {
    "id": "analyze-runs",
    "category": "improve",
    "release": "1.0",
    "title": "Analyze runs",
    "archetype": "review",
    "outcome": "How well the system's own judgments held on the runs you pick: needs-you, floors, QE verdicts, who built it, routing.",
    "words": [
      "evals",
      "evaluate runs",
      "judge quality",
      "accuracy",
      "how good are",
      "analyze runs",
      "run quality",
      "routing accuracy"
    ],
    "needs": [
      "runs"
    ],
    "inputs": [
      "project?",
      "seats"
    ],
    "delivers": "report",
    "gate": [
      "proposal-only"
    ],
    "launch": {
      "kind": "run",
      "workflow": "run-evals"
    },
    "command": "/evals",
    "aliases": [
      {
        "command": "/workflow-run-evals",
        "option": null
      }
    ]
  },
  {
    "id": "review-recent-work",
    "category": "improve",
    "release": "1.0",
    "title": "Review recent work",
    "archetype": "review",
    "outcome": "Recommendations across every run since the last review, with the numbers behind each.",
    "words": [
      "review recent work",
      "what went wrong",
      "insights",
      "slow runs",
      "cost",
      "recommendations",
      "how are runs going"
    ],
    "needs": [
      "runs"
    ],
    "inputs": [
      "seats"
    ],
    "delivers": "report",
    "gate": [
      "proposal-only"
    ],
    "seats": {
      "notRunSeat": true
    },
    "launch": {
      "kind": "run",
      "workflow": "review-recent-work"
    },
    "command": "/review-recent",
    "aliases": [
      {
        "command": "/workflow-review-recent-work",
        "option": null
      }
    ]
  },
  {
    "id": "propose",
    "category": "improve",
    "release": "1.0",
    "title": "Propose rules and memories",
    "outcome": "Steering rules, memories or knowledge, proposed for you to approve; nothing applies until you do.",
    "words": [
      "rules",
      "steering",
      "policy",
      "memories",
      "remember",
      "learn",
      "learnings",
      "knowledge",
      "capture",
      "lessons",
      "conventions"
    ],
    "needs": [
      "repo"
    ],
    "inputs": [
      "intent",
      "repo",
      "project?",
      "seats"
    ],
    "delivers": "proposals",
    "gate": [
      "proposal-only"
    ],
    "seats": {
      "proposalOnly": true
    },
    "command": "/propose",
    "aliases": [
      {
        "command": "/workflow-learn",
        "option": "knowledge"
      }
    ],
    "variant": {
      "axis": "kind",
      "label": "Propose",
      "default": "rules",
      "options": [
        {
          "id": "rules",
          "title": "Rules",
          "words": [
            "rules",
            "steering",
            "policy",
            "policies",
            "conventions",
            "guardrails"
          ],
          "launch": {
            "kind": "run",
            "workflow": "steering-author"
          },
          "changesPlan": false,
          "delivers": "proposals",
          "gate": [
            "proposal-only"
          ],
          "command": "/propose rules"
        },
        {
          "id": "memories",
          "title": "Memories from recent work",
          "words": [
            "memories",
            "lessons",
            "capture",
            "learnings",
            "what we learned"
          ],
          "launch": {
            "kind": "run",
            "workflow": "capture-learnings"
          },
          "changesPlan": true,
          "delivers": "proposals",
          "gate": [
            "proposal-only"
          ],
          "command": "/propose memories"
        },
        {
          "id": "knowledge",
          "title": "Knowledge on a topic",
          "words": [
            "learn",
            "topic",
            "library",
            "standard",
            "catch up on",
            "knowledge"
          ],
          "launch": {
            "kind": "run",
            "workflow": "learn"
          },
          "changesPlan": true,
          "delivers": "pr",
          "gate": [
            "proposal-only",
            "review"
          ],
          "command": "/propose knowledge"
        }
      ]
    }
  },
  {
    "id": "evaluate-rules",
    "category": "improve",
    "release": "1.0",
    "title": "Evaluate rules",
    "archetype": "review",
    "outcome": "Which steering rules catch what they should, which miss, and which fire on good work.",
    "words": [
      "evaluate rules",
      "test rules",
      "steering evals",
      "do the rules work",
      "false positive",
      "rule coverage"
    ],
    "needs": [
      "nothing"
    ],
    "inputs": [
      "project?"
    ],
    "delivers": "report",
    "gate": [
      "proposal-only"
    ],
    "launch": {
      "kind": "run",
      "workflow": "run-evals"
    },
    "command": "/evaluate-rules",
    "aliases": [],
    "evalSuites": [
      "steering"
    ]
  },
  {
    "id": "retro",
    "category": "improve",
    "release": "1.0",
    "title": "Retro",
    "archetype": "review",
    "outcome": "What went well and badly over a stretch of work, and the actions as proposals you approve.",
    "words": [
      "retro",
      "retrospective",
      "lessons learned",
      "post-project",
      "what went well",
      "after action"
    ],
    "needs": [
      "runs"
    ],
    "inputs": [
      "intent",
      "project?",
      "seats"
    ],
    "delivers": "proposals",
    "gate": [
      "proposal-only"
    ],
    "seats": {
      "notRunSeat": true
    },
    "launch": {
      "kind": "run",
      "workflow": "review-recent-work"
    },
    "brief": "Kind: retro over the scope named in the ask; file the actions as proposals.",
    "command": "/retro",
    "aliases": []
  },
  {
    "id": "tune",
    "category": "improve",
    "release": "deferred",
    "title": "Tune a workflow or skill",
    "words": [
      "tune",
      "improve the workflow",
      "tweak the skill"
    ],
    "launch": {
      "kind": "none"
    },
    "status": "coming_soon",
    "statusNote": "Deferred: a change to a workflow or skill needs seat evals to show it helped.",
    "nearest": {
      "card": "analyze-runs",
      "option": null
    },
    "command": null,
    "aliases": []
  }
];
