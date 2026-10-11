import { useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';
import type { AvatarRecord } from '../shared/types';
import { AVATAR_SIZE, BUILTIN_AVATARS } from '../shared/avatars';
import { api } from './api';
import { Mascot } from './Mascot';

/** Fit an image into a transparent square PNG so uploads match bundled avatars. */
async function toAvatarPng(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = AVATAR_SIZE;
    const scale = Math.min(
      AVATAR_SIZE / bitmap.width,
      AVATAR_SIZE / bitmap.height,
    );
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    canvas
      .getContext('2d')!
      .drawImage(
        bitmap,
        (AVATAR_SIZE - width) / 2,
        (AVATAR_SIZE - height) / 2,
        width,
        height,
      );
    return canvas.toDataURL('image/png');
  } finally {
    bitmap.close();
  }
}

export function AvatarPicker({
  value,
  onChange,
  uploaded,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  /** Avatars already known to the workspace when the dialog opened. */
  uploaded: AvatarRecord[];
}) {
  const [added, setAdded] = useState<AvatarRecord[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const custom = [...uploaded, ...added].filter(
    (item, index, all) =>
      !removed.includes(item.id) &&
      all.findIndex((other) => other.id === item.id) === index,
  );
  const upload = async (file: File) => {
    setBusy(true);
    setError('');
    try {
      const record = await api<AvatarRecord>('/avatars', 'POST', {
        label: file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Avatar',
        image: await toAvatarPng(file),
      });
      setAdded((items) => [...items, record]);
      onChange(record.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not upload avatar.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  const remove = async (id: string) => {
    setError('');
    try {
      await api(`/avatars/${id}`, 'DELETE');
      setRemoved((items) => [...items, id]);
      if (value === id) onChange(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove avatar.');
    }
  };
  const option = (id: string, label: string, removable = false) => (
    <div className="avatar-cell" key={id}>
      <button
        type="button"
        role="radio"
        aria-checked={value === id}
        className={`avatar-option ${value === id ? 'selected' : ''}`}
        onClick={() => onChange(id)}
        title={label}
      >
        <Mascot avatar={id} name={label} small decorative />
      </button>
      {removable && (
        <button
          type="button"
          className="avatar-remove"
          aria-label={`Remove ${label}`}
          onClick={() => remove(id)}
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  );
  return (
    <fieldset className="avatar-fields">
      <legend>Avatar</legend>
      <p className="muted">
        Choose a character, or upload your own square PNG or JPEG.
      </p>
      <div className="avatar-grid" role="radiogroup" aria-label="Avatar">
        {BUILTIN_AVATARS.map((item) => option(item.id, item.label))}
        {custom.map((item) => option(item.id, item.label, true))}
        <button
          type="button"
          className="avatar-option avatar-upload"
          onClick={() => input.current?.click()}
          disabled={busy}
          title="Upload an image"
        >
          <Upload size={18} aria-hidden="true" />
          <span>{busy ? 'Uploading…' : 'Upload'}</span>
        </button>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
