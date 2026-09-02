/**
 * The AI provider that does nothing, and is the default (Part IV §68 gate 9).
 *
 * > **Gate 9 — AI gate:** *"human fallback works with AI entirely disabled; RAG/tool
 * > permissions and quality samples pass before autonomous self-service expands."*
 *
 * The first clause is not a feature flag. It is an acceptance gate, and the only way to
 * hold it honestly is for "AI entirely disabled" to be a real, wired configuration that
 * the product runs under — not a branch nobody exercises. So this is the implementation
 * StarLink ships with today, and every path that consults AI has to work while it is the
 * one installed.
 *
 * It is also what N-05 requires. No provider has been chosen and no data-processing
 * agreement has been signed for redacted-transcript processing; until both exist there is
 * nothing this may legitimately call. A stub that returned plausible strings would be
 * worse than this one, because it would let AI-shaped features be built and demonstrated
 * against output nobody is accountable for.
 *
 * ## Why every method fails rather than returning an empty success
 *
 * `FAIL_DEGRADED` is defined in `shared-contracts` as *"the feature disappears, the
 * conversation continues"*, and AI is named in its definition. An empty success is a
 * different claim: it says the model was asked and had nothing to say. A caller cannot
 * distinguish that from "there is no model", so it would render an empty summary panel
 * instead of no summary panel — and an agent would read "no risk signals" where the truth
 * is "nothing looked".
 */
import {
  err,
  type AIProvider,
  type Advisory,
  type HealthReport,
  type Result,
} from '@starlink/shared-contracts';

/** The one error every capability returns. Same code everywhere, so it is greppable. */
const DISABLED_CODE = 'AI_DISABLED';

export interface DisabledAIProviderOptions {
  /**
   * Correlation id for the refusal. A function rather than a value so one long-lived
   * instance does not stamp every refusal with the id of the request that constructed it.
   */
  readonly correlationId?: () => string;
  readonly now?: () => Date;
}

export class DisabledAIProvider implements AIProvider {
  constructor(private readonly options: DisabledAIProviderOptions = {}) {}

  classifyIntent(): Promise<Result<Advisory<never>>> {
    return this.refuse('classifyIntent');
  }

  summarise(): Promise<Result<Advisory<never>>> {
    return this.refuse('summarise');
  }

  draftReply(): Promise<Result<Advisory<never>>> {
    return this.refuse('draftReply');
  }

  answerFromKnowledge(): Promise<Result<Advisory<never>>> {
    return this.refuse('answerFromKnowledge');
  }

  assessRisk(): Promise<Result<Advisory<never>>> {
    return this.refuse('assessRisk');
  }

  extractActions(): Promise<Result<Advisory<never>>> {
    return this.refuse('extractActions');
  }

  /**
   * Reports DOWN, not UP.
   *
   * Tempting to call this UP — nothing is broken, after all. But `HealthReport` is what a
   * dashboard and an incident review read, and "the AI provider is up" while no provider
   * exists is a false statement that would be believed. `authority: 'MOCK'` says the rest:
   * INTEGRATION_CONTRACTS §1 rule 4 exists so that an interim implementation can never be
   * mistaken for a canonical one.
   */
  async health(): Promise<HealthReport> {
    return {
      status: 'DOWN',
      authority: 'MOCK',
      checkedAt: (this.options.now ?? (() => new Date()))().toISOString() as never,
      detail:
        'AI is disabled. No provider is configured and none has been approved (N-05). ' +
        'Every human path works without it — Part IV §68 gate 9.',
    };
  }

  private async refuse(capability: string): Promise<Result<Advisory<never>>> {
    return err({
      code: DISABLED_CODE,
      message: `AI capability "${capability}" is disabled: no provider is configured.`,
      // Not retryable. A retry loop against a decision is a busy loop, and this is a
      // decision — the absence of an approved provider, not a transient outage.
      retryable: false,
      // "The feature disappears, the conversation continues." The caller must degrade,
      // never fail its own operation.
      failureClass: 'FAIL_DEGRADED',
      correlationId: this.options.correlationId?.() ?? 'ai-disabled',
      detail: { capability },
    });
  }
}

/** True where a result failed because AI is off, rather than because a call went wrong. */
export const isAiDisabled = (result: Result<unknown>): boolean =>
  !result.ok && result.error.code === DISABLED_CODE;
