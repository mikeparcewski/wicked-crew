/**
 * The reserved, synthesized "Unfiled" project id (DES-PROJECT-001 §1.1/§7).
 *
 * A leaf module on purpose: the interactive root resolver (`interactive/bridge-root.ts`) has to
 * recognize this id to keep the legacy shared docs root for it (crew#472), and it must stay
 * importable without dragging the whole project route layer — zod, the engine adapter — behind a
 * one-word constant.
 */
export const DEFAULT_PROJECT_ID = 'default';
