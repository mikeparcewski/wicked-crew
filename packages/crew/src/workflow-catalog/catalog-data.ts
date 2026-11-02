/**
 * The workflow catalog's browsing metadata (lane wf-catalog, operator 2026-11-01): THE one place a
 * workflow's category, outcome, needs, inputs, hints, search words, status and launch kind live.
 *
 * Data only. What a workflow DOES lives where it already lives: its steps in the engine's built-in
 * presets (wicked-core `src/presets/*.json`) or crew's own defs (`workflows/*.json`), its title,
 * summary and use-when on the def (core's `builtin_preset_descriptor`, C2). A `run` seed never repeats
 * them (pinned by a test), so there is no second copy to drift. Only a seed with no def (studio's own
 * flows, coming soon) carries its own copy.
 *
 * Copy here is a product claim: a card promises only what works today (approved messaging rules N5, N7, N8;
 * pinned by tests/workflow-catalog.test.ts). Search-only `synonyms` may name what people type for it.
 *
 * Adding a workflow to the catalog = one seed here. A served, hand-launchable workflow with no seed and
 * not in {@link CATALOG_EXCLUDED} still appears (under `more`), so nothing launchable is ever lost.
 */
import type {
  WorkflowCatalogCategory,
  WorkflowCatalogCategoryId,
  WorkflowCatalogEntry,
  WorkflowCatalogInput,
} from '../core/types.js';

/** One catalog seed. `title`/`summary`/`useWhen` only on a seed whose launch is not `run`. */
export type CatalogSeed = Omit<
  WorkflowCatalogEntry,
  'title' | 'summary' | 'useWhen' | 'status' | 'statusNote' | 'requiresQe' | 'source' | 'usage'
> & {
  title?: string;
  summary?: string;
  useWhen?: string[];
  /** Set only for coming soon; a run seed's availability is the engine's (served or not). */
  status?: 'coming_soon';
  statusNote?: string;
};

export const CATALOG_CATEGORIES: readonly WorkflowCatalogCategory[] = [
  {
    id: 'create',
    title: 'Create',
    summary: 'Make something new: a feature, docs, a deck, a demo, a plugin or a tool.',
    subcategories: [
      { id: 'apps', title: 'Apps' },
      { id: 'feature', title: 'Feature' },
      { id: 'documentation', title: 'Documentation' },
      { id: 'presentation', title: 'Presentation' },
      { id: 'demo', title: 'Demo (video)' },
      { id: 'phase-plugin', title: 'Studio phase plugin' },
      { id: 'editor-plugin', title: 'Studio editor plugin' },
      { id: 'mcp', title: 'MCP tools' },
    ],
  },
  {
    id: 'resolve',
    title: 'Resolve',
    summary: 'Fix what is broken or move off what is old.',
    subcategories: [
      { id: 'issue', title: 'Issue' },
      { id: 'migrate', title: 'Migrate' },
    ],
  },
  {
    id: 'analyze',
    title: 'Analyze',
    summary: 'Understand a codebase, your runs or your docs, changing nothing in the code.',
    subcategories: [
      { id: 'domain', title: 'Domain extraction' },
      { id: 'run-review', title: 'Run review' },
      { id: 'validate-docs', title: 'Validate documentation' },
    ],
  },
  {
    id: 'test',
    title: 'Test',
    summary: 'Plan tests, find the gaps and write the tests.',
    subcategories: [
      { id: 'planning', title: 'Planning' },
      { id: 'analysis', title: 'Analysis' },
      { id: 'automation', title: 'Automation' },
    ],
  },
  {
    id: 'more',
    title: 'More',
    summary: 'Everything else you can start by hand.',
    subcategories: [],
  },
  {
    id: 'yours',
    title: 'Your workflows',
    summary: 'Workflows you saved.',
    subcategories: [],
  },
];

const INTENT = (label: string, required = true): WorkflowCatalogInput => ({ id: 'intent', label, kind: 'text', required });
const REPO: WorkflowCatalogInput = { id: 'repo', label: 'Repository', kind: 'repo', required: true };
const REPO_OPTIONAL: WorkflowCatalogInput = { id: 'repo', label: 'Repository', kind: 'repo', required: false };
const PROJECT: WorkflowCatalogInput = { id: 'project', label: 'Project', kind: 'project', required: false };
const PROJECT_REQUIRED: WorkflowCatalogInput = { id: 'project', label: 'Project', kind: 'project', required: true };
const SEATS: WorkflowCatalogInput = { id: 'seats', label: 'Who works on it', kind: 'seats', required: false };

/** A code-changing run on a repository: what to do, where, who. */
const RUN_ON_REPO = (label: string): WorkflowCatalogInput[] => [INTENT(label), REPO, PROJECT, SEATS];

export const CATALOG_SEEDS: readonly CatalogSeed[] = [
  // ── Create ──
  {
    // Operator ruling 2026-11-02: the data builder (was Vibe, working name Create) is named Apps.
    id: 'apps',
    category: 'create',
    subcategory: 'apps',
    title: 'Apps',
    summary: 'Build a live app, dashboard or tool over your own data and APIs by describing it.',
    useWhen: ['a dashboard over your data', 'an internal tool without a codebase'],
    outcome: 'Live apps and dashboards over your APIs and databases.',
    needs: ['project'],
    inputs: [],
    typicalMinutes: null,
    cost: null,
    tags: ['app', 'dashboard', 'no-code'],
    synonyms: ['apps', 'app', 'dashboard', 'data app', 'internal tool', 'vibe', 'vibe code', 'ui builder', 'create', 'prototype', 'build an app'],
    launch: { kind: 'none' },
    delivers: 'none',
    status: 'coming_soon',
    statusNote: 'Design in progress.',
  },
  {
    id: 'feature',
    category: 'create',
    subcategory: 'feature',
    outcome: 'A pull request with the change, checked by tests and a review, after QE acceptance.',
    needs: ['repo'],
    inputs: RUN_ON_REPO('What should it do?'),
    typicalMinutes: [60, 240],
    cost: 'high',
    tags: ['code', 'pull request', 'tests'],
    synonyms: ['build', 'implement', 'add', 'new feature', 'enhancement', 'story', 'change'],
    launch: { kind: 'run', workflow: 'feature' },
    delivers: 'pr',
  },
  {
    id: 'docs',
    category: 'create',
    subcategory: 'documentation',
    outcome: 'A pull request with Markdown docs whose every claim was checked against the code.',
    needs: ['repo'],
    inputs: RUN_ON_REPO('What should the docs cover, and for whom?'),
    typicalMinutes: null,
    cost: 'medium',
    tags: ['markdown', 'readme', 'pull request'],
    synonyms: ['documentation', 'readme', 'guide', 'api reference', 'docs', 'write docs', 'md'],
    launch: { kind: 'run', workflow: 'docs' },
    delivers: 'pr',
  },
  {
    id: 'document-interactive',
    category: 'create',
    subcategory: 'documentation',
    title: 'Interactive document',
    // Chat refinement of a document is not built (rule N8): it is edited in place, by hand.
    summary: 'Draft a web page document from a brief, grounded in your repositories, then edit it in place in studio.',
    useWhen: ['a living spec or explainer', 'a page people click through'],
    outcome: 'A versioned HTML document in studio that you can edit in place and export as PDF.',
    needs: ['project'],
    inputs: [INTENT('What is it about?'), PROJECT_REQUIRED, REPO_OPTIONAL, SEATS],
    typicalMinutes: [10, 20],
    cost: 'medium',
    tags: ['html', 'document', 'interactive'],
    synonyms: ['web page', 'html', 'spec', 'explainer', 'one pager'],
    launch: { kind: 'document', style: 'web' },
    delivers: 'document',
  },
  {
    id: 'document-static',
    category: 'create',
    subcategory: 'documentation',
    title: 'Document',
    summary: 'Draft a prose document from a brief, grounded in your repositories, ready to export.',
    useWhen: ['a memo, white paper or proposal', 'a document to print or send as PDF'],
    outcome: 'A document in studio you can edit in place and export as PDF.',
    needs: ['project'],
    inputs: [INTENT('What is it about?'), PROJECT_REQUIRED, REPO_OPTIONAL, SEATS],
    typicalMinutes: [10, 20],
    cost: 'medium',
    tags: ['pdf', 'document'],
    synonyms: ['memo', 'white paper', 'proposal', 'report', 'pdf', 'word', 'docx', 'write up'],
    launch: { kind: 'document', style: 'doc' },
    delivers: 'document',
  },
  {
    id: 'presentation',
    category: 'create',
    subcategory: 'presentation',
    title: 'Presentation',
    summary: 'Draft a slide deck from a brief, grounded in your repositories.',
    useWhen: ['a deck for a review or a pitch', 'walk people through a change'],
    // No PowerPoint here until its export works on a stock install (wicked-interactive#322: the exporter needs
    // python-pptx, which nothing installs; rule N8). Add "or PowerPoint" back when #322 ships.
    outcome: '16:9 slides in studio you can edit in place and export as PDF.',
    needs: ['project'],
    inputs: [INTENT('What is the deck about, and for whom?'), PROJECT_REQUIRED, REPO_OPTIONAL, SEATS],
    typicalMinutes: [10, 20],
    cost: 'medium',
    tags: ['slides', 'deck'],
    synonyms: ['slides', 'deck', 'slide deck', 'pitch', 'keynote', 'powerpoint', 'pptx'],
    launch: { kind: 'document', style: 'ppt' },
    delivers: 'document',
  },
  {
    id: 'demo-video',
    category: 'create',
    subcategory: 'demo',
    title: 'Demo video',
    // The engine renders no audio (wicked-interactive demo-cut.js; rule N7): captions, no voice-over.
    summary: 'Plan, record and review a captioned demo video of a running app (no voice-over).',
    useWhen: ['show a feature working', 'a product walkthrough on video'],
    outcome: 'A captioned video of your app, recorded and reviewed.',
    needs: ['project', 'running_app'],
    inputs: [
      PROJECT_REQUIRED,
      { id: 'url', label: 'Where the app runs', kind: 'url', required: true },
      // The demo route requires both (`DemoLaunchSchema`, api/recording.ts; codex r3).
      { id: 'audience', label: 'Who it is for', kind: 'text', required: true },
      { id: 'show', label: 'What to show', kind: 'text', required: true },
    ],
    typicalMinutes: null,
    cost: 'medium',
    tags: ['video', 'demo'],
    synonyms: ['video', 'screencast', 'recording', 'walkthrough', 'demo'],
    launch: { kind: 'demo' },
    delivers: 'video',
  },
  {
    id: 'phase-plugin',
    category: 'create',
    subcategory: 'phase-plugin',
    title: 'Studio phase plugin',
    summary: 'Build a new kind of step that workflows can use.',
    useWhen: ['a step no workflow has yet', 'your own check or tool inside a run'],
    outcome: 'A new step you can add to any plan.',
    needs: ['repo'],
    inputs: [],
    typicalMinutes: null,
    cost: null,
    tags: ['plugin', 'phase', 'step'],
    synonyms: ['phase', 'step', 'custom step', 'plugin'],
    launch: { kind: 'none' },
    delivers: 'none',
    status: 'coming_soon',
    statusNote: 'A step is part of the engine today; plugging in your own is not built yet.',
  },
  {
    id: 'editor-plugin',
    category: 'create',
    subcategory: 'editor-plugin',
    outcome: 'An editor plugin designed, built, tested and installed in studio after your consent.',
    needs: ['repo'],
    inputs: RUN_ON_REPO('What kind of file should it edit, and how?'),
    typicalMinutes: [30, 120],
    cost: 'high',
    tags: ['plugin', 'studio', 'editor'],
    synonyms: ['editor', 'plugin', 'viewer', 'file type', 'studio plugin'],
    launch: { kind: 'run', workflow: 'editor-plugin' },
    delivers: 'pr',
  },
  {
    id: 'mcp-server',
    category: 'create',
    subcategory: 'mcp',
    outcome: 'An MCP server with its tools, tested, reviewed for security and installed after your consent.',
    needs: ['repo'],
    inputs: RUN_ON_REPO('What tools should agents get?'),
    typicalMinutes: null,
    cost: 'high',
    tags: ['mcp', 'tools', 'agents'],
    synonyms: ['mcp', 'tool', 'tools', 'server', 'integration', 'connector'],
    launch: { kind: 'run', workflow: 'mcp-server' },
    delivers: 'pr',
  },
  // ── Resolve ──
  {
    id: 'bug',
    category: 'resolve',
    subcategory: 'issue',
    outcome: 'A pull request with the fix and the checks that show it holds, after QE acceptance.',
    needs: ['repo'],
    inputs: RUN_ON_REPO('What is wrong? Paste the error or the issue.'),
    typicalMinutes: [10, 60],
    cost: 'medium',
    tags: ['bug', 'fix', 'pull request'],
    synonyms: ['issue', 'defect', 'broken', 'error', 'crash', 'regression', 'fix'],
    launch: { kind: 'run', workflow: 'bug' },
    delivers: 'pr',
  },
  {
    id: 'migration',
    category: 'resolve',
    subcategory: 'migrate',
    outcome: 'A planned move with a confirmed cutover and the old path removed, as a pull request.',
    needs: ['repo'],
    inputs: RUN_ON_REPO('What are you moving from, and to what?'),
    typicalMinutes: null,
    cost: 'high',
    tags: ['migration', 'upgrade'],
    synonyms: ['migrate', 'upgrade', 'port', 'replace', 'move to', 'cutover', 'deprecate'],
    launch: { kind: 'run', workflow: 'migration' },
    delivers: 'pr',
  },
  // ── Analyze ──
  {
    id: 'domain-extraction',
    category: 'analyze',
    subcategory: 'domain',
    outcome: 'A requirements map of what the code does, with how much of the code it covers.',
    needs: ['repo', 'project'],
    inputs: [INTENT('Anything to focus on?', false), REPO, PROJECT_REQUIRED, SEATS],
    typicalMinutes: [10, 30],
    cost: 'high',
    tags: ['requirements', 'domain'],
    synonyms: ['requirements', 'domain', 'reverse engineer', 'what does it do', 'business rules', 'map'],
    launch: { kind: 'run', workflow: 'domain-extraction' },
    delivers: 'report',
  },
  {
    id: 'review-recent-work',
    category: 'analyze',
    subcategory: 'run-review',
    outcome: 'Recommendations across every run since the last review, with the numbers behind each.',
    needs: ['runs'],
    inputs: [SEATS],
    typicalMinutes: [1, 5],
    cost: 'low',
    tags: ['runs', 'insights'],
    synonyms: ['retro', 'retrospective', 'run review', 'what went wrong', 'insights', 'cost', 'slow runs'],
    launch: { kind: 'run', workflow: 'review-recent-work' },
    delivers: 'report',
  },
  {
    id: 'validate-docs',
    category: 'analyze',
    subcategory: 'validate-docs',
    outcome: 'A report of every wrong or stale claim in your docs, with the code line that contradicts it.',
    needs: ['repo'],
    inputs: [INTENT('Which docs? (blank = the READMEs and docs/)', false), REPO, PROJECT, SEATS],
    typicalMinutes: null,
    cost: 'low',
    tags: ['docs', 'report', 'read-only'],
    synonyms: ['check docs', 'docs drift', 'stale docs', 'validate documentation', 'verify readme', 'fact check'],
    launch: { kind: 'run', workflow: 'validate-docs' },
    delivers: 'report',
  },
  // ── Test ──
  {
    id: 'test-plan',
    category: 'test',
    subcategory: 'planning',
    outcome: 'A risk-ranked test plan file in a pull request, ready to automate.',
    needs: ['repo'],
    inputs: RUN_ON_REPO('What should the plan cover?'),
    typicalMinutes: null,
    cost: 'medium',
    tags: ['tests', 'plan', 'qe'],
    synonyms: ['test plan', 'test strategy', 'what to test', 'scenarios', 'qa plan'],
    launch: { kind: 'run', workflow: 'test-plan' },
    delivers: 'pr',
  },
  {
    id: 'test-analysis',
    category: 'test',
    subcategory: 'analysis',
    outcome: 'A ranked report of untested risky code and weak or flaky tests, each with the test that closes it.',
    needs: ['repo'],
    inputs: [INTENT('Anything to focus on?', false), REPO, PROJECT, SEATS],
    typicalMinutes: null,
    cost: 'low',
    tags: ['tests', 'coverage', 'read-only'],
    synonyms: ['coverage', 'test gaps', 'flaky tests', 'test quality', 'audit tests', 'test debt'],
    launch: { kind: 'run', workflow: 'test-analysis' },
    delivers: 'report',
  },
  {
    id: 'qe-author-tests',
    category: 'test',
    subcategory: 'automation',
    outcome: 'A pull request with behaviour tests that ran green under your own test setup.',
    needs: ['repo'],
    inputs: RUN_ON_REPO('What should the tests cover?'),
    typicalMinutes: null,
    cost: 'medium',
    tags: ['tests', 'automation', 'pull request'],
    synonyms: ['write tests', 'automate tests', 'unit tests', 'e2e', 'test automation', 'add tests'],
    launch: { kind: 'run', workflow: 'qe-author-tests' },
    delivers: 'pr',
  },
  // ── More ──
  {
    id: 'start-chat',
    category: 'more',
    subcategory: null,
    title: 'Start a chat',
    summary: 'Ask about your code and work, cited, on its own page; start a job from it when you are ready.',
    useWhen: ['ask a question', 'think something through first'],
    outcome: 'Cited answers, and a job when you decide on one.',
    needs: ['nothing'],
    inputs: [],
    typicalMinutes: null,
    cost: 'low',
    tags: ['chat', 'questions'],
    synonyms: ['ask', 'question', 'chat', 'explain', 'how does'],
    launch: { kind: 'chat' },
    delivers: 'answer',
  },
  {
    id: 'learn',
    category: 'more',
    subcategory: null,
    outcome: 'What was learned, with its sources, saved to the repository as a pull request.',
    needs: ['repo'],
    inputs: RUN_ON_REPO('What topic or event?'),
    typicalMinutes: null,
    cost: 'medium',
    tags: ['research', 'knowledge'],
    synonyms: ['research', 'learn', 'catch up', 'read up', 'study'],
    launch: { kind: 'run', workflow: 'learn' },
    delivers: 'pr',
  },
  {
    id: 'draft-epics',
    category: 'more',
    subcategory: null,
    title: 'Draft epics',
    summary: "Turn a project's requirements into epics and stories.",
    useWhen: ['plan work from requirements', 'a backlog from a requirements map'],
    outcome: 'Epics and stories drafted from the requirements you pick.',
    needs: ['project', 'requirements'],
    inputs: [PROJECT_REQUIRED, { id: 'requirements', label: 'Requirements', kind: 'requirements', required: true }],
    typicalMinutes: null,
    cost: 'low',
    tags: ['backlog', 'requirements'],
    synonyms: ['epics', 'stories', 'backlog', 'user stories', 'plan work'],
    launch: { kind: 'compose' },
    delivers: 'document',
  },
  {
    id: 'run-evals',
    category: 'more',
    subcategory: null,
    outcome: "How well the system's own judgments agree with what really happened in your runs.",
    needs: ['runs'],
    inputs: [SEATS],
    typicalMinutes: [1, 5],
    cost: 'low',
    tags: ['evals', 'quality'],
    synonyms: ['evals', 'evaluation', 'accuracy', 'judge quality'],
    launch: { kind: 'run', workflow: 'run-evals' },
    delivers: 'report',
  },
];

/**
 * Served, non-system workflows the catalog deliberately does not offer by hand, each with its reason.
 * Without this list they would join `more` (the never-lose rule); with it, a launch surface stays clean.
 */
export const CATALOG_EXCLUDED: Readonly<Record<string, string>> = {
  'distill-learnings': 'runs by itself after each finished run, on that run',
};

/** The categories' display order, for sorting. */
export const CATEGORY_ORDER: readonly WorkflowCatalogCategoryId[] = CATALOG_CATEGORIES.map((c) => c.id);
