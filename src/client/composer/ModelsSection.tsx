import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../api';
import type { ModelConnection, ProviderPreset } from '../../shared/providers';

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
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [found, setFound] = useState<Record<string, string[]>>({});

  const preset = providers.find((item) => item.id === providerId);

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
        label: preset?.label ?? '',
        baseUrl,
        apiKey,
      });
      setAdding(false);
      setApiKey('');
      setBaseUrl('');
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
        const offered = found[connection.id] ?? connection.models;
        return (
          <div className="model-connection" key={connection.id}>
            <div className="model-connection-head">
              <strong>{connection.label}</strong>
              <code>{connection.baseUrl}</code>
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
            }}
          >
            {providers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          {preset?.note && <p className="muted small">{preset.note}</p>}

          <label className="field-label" htmlFor="model-url">
            Address
          </label>
          <input
            id="model-url"
            value={baseUrl}
            placeholder={preset?.baseUrl || 'https://your-server/v1'}
            onChange={(event) => setBaseUrl(event.target.value)}
          />

          {preset?.needsKey && (
            <>
              <label className="field-label" htmlFor="model-key">
                API key
              </label>
              <input
                id="model-key"
                type="password"
                value={apiKey}
                autoComplete="off"
                placeholder="Stored on your server, never shown again"
                onChange={(event) => setApiKey(event.target.value)}
              />
              {preset.keyUrl && (
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
