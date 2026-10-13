import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Loader2,
  PlayCircle,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { api } from '../api';
import {
  looksLikeChatModel,
  sortModelNames,
  type ConnectionTest,
  type ModelConnection,
  type ProviderPreset,
} from '../../shared/providers';

/**
 * Which models a connection can be tested against. The ticked ones are
 * what the composer would use, so they come first; before anything is
 * ticked, whatever discovery just found is still worth testing.
 */
export function testCandidates(
  connection: Pick<ModelConnection, 'models'>,
  offered: string[] = [],
): string[] {
  return connection.models.length ? connection.models : offered;
}

/** Round-trip time, in the units a person reads at a glance. */
export function latencyLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * How long ago a test ran. Blank for one that just finished, because the
 * result is right there; older than that and the age is the point, since a
 * green tick from last week proves nothing about now.
 */
export function agoLabel(at: number, now = Date.now()): string {
  const seconds = Math.round((now - at) / 1000);
  if (!Number.isFinite(seconds) || seconds < 60) return '';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** Tokens the provider reported, when it reported any. */
export function usageLabel(usage: ConnectionTest['usage']): string {
  const total =
    usage?.totalTokens ??
    (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0);
  return total ? `${total} tokens` : '';
}

/**
 * The outcome of a test, inline under the connection that ran it: what it
 * said, how long it took, or why it did not answer.
 */
export function TestOutcome({
  result,
  now,
}: {
  result: ConnectionTest;
  now?: number;
}) {
  const ago = agoLabel(result.at, now);
  if (!result.ok)
    return (
      <div className="model-test-failed" role="alert">
        <TriangleAlert size={13} aria-hidden="true" />
        <span>
          <strong>{result.model || 'That connection'} did not answer.</strong>
          <small>
            {result.error ?? 'No reason was reported.'}
            {ago && ` · ${ago}`}
          </small>
        </span>
      </div>
    );
  const tokens = usageLabel(result.usage);
  return (
    <div className="model-test-ok" role="status">
      <p className="model-test-meta">
        <Check size={13} aria-hidden="true" />
        <span>
          {result.model} replied in {latencyLabel(result.latencyMs)}
          {tokens && ` · ${tokens}`}
          {ago && ` · ${ago}`}
        </span>
      </p>
      <blockquote>{result.reply?.trim() || '(an empty reply)'}</blockquote>
    </div>
  );
}

/**
 * Connect the LLMs the owner already has.
 *
 * Everything here speaks the OpenAI chat-completions shape, so a
 * connection is a base URL, an optional key, and the models they tick.
 * Keys are posted once and never read back; the server only ever reports
 * whether one is stored.
 */
export function ModelsSection() {
  const [providers, setProviders] = useState<ProviderPreset[]>([]);
  const [connections, setConnections] = useState<ModelConnection[]>([]);
  const [adding, setAdding] = useState(false);
  const [providerId, setProviderId] = useState('openai');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  // Per connection: whether to list everything the endpoint offered rather
  // than only what looks like a chat model.
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [found, setFound] = useState<Record<string, string[]>>({});
  // Per connection: which model to test, and this session's result. The
  // server keeps the last one too, so a reopened panel still shows it.
  const [testModel, setTestModel] = useState<Record<string, string>>({});
  const [tested, setTested] = useState<Record<string, ConnectionTest>>({});

  const preset = providers.find((item) => item.id === providerId);
  /**
   * Whether this provider has an API key field at all.
   *
   * `needsKey` means a key is required, which is not the same as a key
   * being used: the custom preset sends a bearer token when one is stored
   * but does not demand one. A key that is stored and sent must be one the
   * owner typed into a field they could see.
   */
  const showKey = !!preset && (preset.needsKey || preset.auth === 'bearer');

  const load = useCallback(async () => {
    try {
      const data = await api<{
        providers: ProviderPreset[];
        connections: ModelConnection[];
      }>('/model-connections');
      setProviders(data.providers);
      setConnections(data.connections);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load connections.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    setBusy('add');
    setError('');
    try {
      const created = await api<ModelConnection>('/model-connections', 'POST', {
        providerId,
        label: label.trim() || preset?.label || '',
        baseUrl,
        // Only ever the key from a field that was on screen. Otherwise
        // switching provider after typing one would attach it silently to
        // whatever address was pasted next.
        ...(showKey ? { apiKey } : {}),
      });
      setAdding(false);
      setApiKey('');
      setBaseUrl('');
      setLabel('');
      await load();
      // Offer its models straight away; that is the only reason to add one.
      await discover(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add that.');
    } finally {
      setBusy('');
    }
  };

  const discover = async (id: string) => {
    setBusy(id);
    setError('');
    try {
      const data = await api<{ models: string[] }>(
        `/model-connections/${id}/discover`,
        'POST',
        {},
      );
      setFound((current) => ({ ...current, [id]: data.models }));
      if (!data.models.length)
        setError('That endpoint reported no chat models.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach it.');
    } finally {
      setBusy('');
      void load();
    }
  };

  /**
   * The only thing that proves a connection works: one real completion.
   * The chat path needs the Intelligence runtime, which a local setup may
   * not have, so without this there is nothing to click that tells the
   * owner their key or their local server is actually answering.
   *
   * A refusal is an outcome, not a crash: the server reports it as a
   * failed test, and a transport error is turned into the same shape so
   * both read the same way.
   */
  const test = async (connection: ModelConnection, model: string) => {
    setBusy(`test:${connection.id}`);
    setError('');
    setTested((current) => {
      const next = { ...current };
      delete next[connection.id];
      return next;
    });
    try {
      const result = await api<ConnectionTest>(
        `/model-connections/${connection.id}/test`,
        'POST',
        { model },
      );
      setTested((current) => ({
        ...current,
        [connection.id]: { ...result, at: result.at ?? Date.now() },
      }));
    } catch (e) {
      setTested((current) => ({
        ...current,
        [connection.id]: {
          ok: false,
          model,
          latencyMs: 0,
          error:
            e instanceof Error
              ? e.message
              : 'The test could not be run. Is the server up?',
          at: Date.now(),
        },
      }));
    } finally {
      setBusy('');
      // A test records what it found server-side, so pick that up too.
      void load();
    }
  };

  const toggle = async (connection: ModelConnection, model: string) => {
    const next = connection.models.includes(model)
      ? connection.models.filter((item) => item !== model)
      : [...connection.models, model];
    setConnections((current) =>
      current.map((item) =>
        item.id === connection.id ? { ...item, models: next } : item,
      ),
    );
    try {
      await api(`/model-connections/${connection.id}/models`, 'PUT', {
        models: next,
      });
    } catch {
      void load();
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Remove this connection and its models?')) return;
    try {
      await api(`/model-connections/${id}`, 'DELETE');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove it.');
    }
  };

  return (
    <fieldset className="models-section">
      <legend>Models</legend>
      <p className="muted">
        Connect any OpenAI-compatible endpoint: a hosted key, or a local server
        like Ollama. Tick the models you want in the composer.
      </p>

      {connections.map((connection) => {
        /*
         * Everything known about this endpoint: what it last offered, what
         * this session's probe found, and what is already ticked. Reopening
         * the panel then shows the full catalog rather than only the ticked
         * models, with no second round trip.
         */
        const pool = sortModelNames([
          ...connection.models,
          ...connection.allModels,
          ...(found[connection.id] ?? []),
        ]);
        const everything = showAll[connection.id] ?? false;
        // The chat filter is a heuristic, so it has to be overrulable: a
        // real chat model whose name contains "guard" or "audio" would
        // otherwise be discovered, stored, and never tickable.
        const offered = everything
          ? pool
          : pool.filter(
              (model) =>
                connection.models.includes(model) || looksLikeChatModel(model),
            );
        const hidden = pool.length - offered.length;
        const candidates = testCandidates(connection, offered);
        // The remembered pick only counts while it is still on offer.
        // Otherwise the select renders blank and the button posts a name
        // the endpoint would answer for with "no such model".
        const picked = testModel[connection.id];
        const chosen =
          picked && candidates.includes(picked)
            ? picked
            : (candidates[0] ?? '');
        const outcome = tested[connection.id] ?? connection.lastTest;
        return (
          <div className="model-connection" key={connection.id}>
            <div className="model-connection-head">
              <strong>{connection.label}</strong>
              <code>{connection.baseUrl}</code>
              {connection.hasKey && (
                <span
                  className="prompt-cap"
                  title="An API key is stored for this connection."
                >
                  Key stored
                </span>
              )}
              <span className="grow" />
              <button
                type="button"
                className="icon-button"
                aria-label={`Refresh models for ${connection.label}`}
                disabled={busy === connection.id}
                onClick={() => void discover(connection.id)}
              >
                {busy === connection.id ? (
                  <Loader2 size={14} className="spin" aria-hidden="true" />
                ) : (
                  <RefreshCw size={14} aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${connection.label}`}
                onClick={() => void remove(connection.id)}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>
            {connection.error && (
              <p className="error" role="alert">
                {connection.error}
              </p>
            )}
            {offered.length > 0 ? (
              <div className="model-choices">
                {offered.map((model) => (
                  <button
                    type="button"
                    key={model}
                    role="switch"
                    aria-checked={connection.models.includes(model)}
                    className={
                      connection.models.includes(model) ? 'model-on' : ''
                    }
                    onClick={() => void toggle(connection, model)}
                  >
                    {connection.models.includes(model) && (
                      <Check size={12} aria-hidden="true" />
                    )}
                    {model}
                  </button>
                ))}
              </div>
            ) : (
              !connection.error && (
                <p className="muted small">
                  No models listed yet. Use refresh to ask this endpoint what it
                  serves.
                </p>
              )
            )}
            {(hidden > 0 || everything) && (
              <button
                type="button"
                className="text-button"
                aria-pressed={everything}
                onClick={() =>
                  setShowAll((current) => ({
                    ...current,
                    [connection.id]: !everything,
                  }))
                }
              >
                {everything
                  ? 'Show chat models only'
                  : `Show everything (${hidden} more)`}
              </button>
            )}

            <div className="model-test">
              <label
                className="field-label"
                htmlFor={`model-test-${connection.id}`}
              >
                Test with
              </label>
              <select
                id={`model-test-${connection.id}`}
                value={chosen}
                disabled={!candidates.length}
                onChange={(event) =>
                  setTestModel((current) => ({
                    ...current,
                    [connection.id]: event.target.value,
                  }))
                }
              >
                {candidates.length ? (
                  candidates.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))
                ) : (
                  <option value="">No models yet</option>
                )}
              </select>
              <button
                type="button"
                className="primary model-test-run"
                disabled={!chosen || busy === `test:${connection.id}`}
                title={
                  candidates.length
                    ? 'Sends one short message and shows what comes back.'
                    : 'Refresh this connection, then tick a model to test.'
                }
                onClick={() => void test(connection, chosen)}
              >
                {busy === `test:${connection.id}` ? (
                  <>
                    <Loader2 size={13} className="spin" aria-hidden="true" />
                    Testing…
                  </>
                ) : (
                  <>
                    <PlayCircle size={13} aria-hidden="true" />
                    Test connection
                  </>
                )}
              </button>
            </div>
            {outcome && <TestOutcome result={outcome} />}
            {!outcome && candidates.length > 0 && (
              <p className="muted small">
                Not tested yet. One short message proves the key, the address
                and the model in one go.
              </p>
            )}
          </div>
        );
      })}

      {adding ? (
        <div className="model-add">
          <label className="field-label" htmlFor="model-provider">
            Provider
          </label>
          <select
            id="model-provider"
            value={providerId}
            onChange={(event) => {
              setProviderId(event.target.value);
              setBaseUrl('');
              // The address resets, so the key must too: a key typed for
              // one provider is not a key for the next one, and the field
              // may not even be shown again.
              setApiKey('');
            }}
          >
            {providers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          {preset?.note && <p className="muted small">{preset.note}</p>}

          <label className="field-label" htmlFor="model-label">
            Name
          </label>
          <input
            id="model-label"
            value={label}
            placeholder={preset?.label ?? 'This connection'}
            onChange={(event) => setLabel(event.target.value)}
          />
          <p className="muted small">
            Shown beside every model from this endpoint. Two connections to the
            same provider are otherwise indistinguishable in the picker.
          </p>

          <label className="field-label" htmlFor="model-url">
            Address
          </label>
          <input
            id="model-url"
            value={baseUrl}
            placeholder={preset?.baseUrl || 'https://your-server/v1'}
            onChange={(event) => setBaseUrl(event.target.value)}
          />

          {showKey && (
            <>
              <label className="field-label" htmlFor="model-key">
                API key{preset?.needsKey ? '' : ' (optional)'}
              </label>
              <input
                id="model-key"
                type="password"
                value={apiKey}
                autoComplete="off"
                placeholder="Stored on your server, never shown again"
                onChange={(event) => setApiKey(event.target.value)}
              />
              {preset?.keyUrl && (
                <p className="muted small">
                  <a href={preset.keyUrl} target="_blank" rel="noreferrer">
                    Where to find your key
                  </a>
                </p>
              )}
            </>
          )}

          <div className="model-add-actions">
            <button type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy === 'add'}
              onClick={() => void add()}
            >
              {busy === 'add' ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="model-add-open"
          onClick={() => setAdding(true)}
        >
          <Plus size={14} aria-hidden="true" /> Connect a model
        </button>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
