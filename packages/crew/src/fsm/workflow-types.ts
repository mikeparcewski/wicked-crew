import type { GateKind } from '../store/types.js';

export interface PhaseDefinition {
  id: string;
  label: string;
  gate_kind: GateKind;
}

export interface WorkflowType {
  id: string;
  phases: PhaseDefinition[];
}

const featurePhases: PhaseDefinition[] = [
  { id: 'clarify', label: 'Clarify', gate_kind: 'auto' },
  { id: 'design', label: 'Design', gate_kind: 'auto' },
  { id: 'test-strategy', label: 'Test Strategy', gate_kind: 'auto' },
  { id: 'build', label: 'Build', gate_kind: 'auto' },
  { id: 'test', label: 'Test', gate_kind: 'auto' },
  { id: 'ship', label: 'Ship', gate_kind: 'auto' },
];

export const workflowTypes: Record<string, WorkflowType> = {
  feature: { id: 'feature', phases: featurePhases },
  bugfix: {
    id: 'bugfix',
    phases: [
      { id: 'clarify', label: 'Clarify', gate_kind: 'auto' },
      { id: 'build', label: 'Build', gate_kind: 'auto' },
      { id: 'test', label: 'Test', gate_kind: 'auto' },
    ],
  },
};

export function getWorkflowType(id: string): WorkflowType {
  const wf = workflowTypes[id];
  if (!wf) throw new Error(`Unknown workflow type: ${id}`);
  return wf;
}
