/**
 * B-01 regression net: the firstEmptyDevice first-sync branch performs a destructive full
 * replacement of a fresh device's local database. It must therefore consume the same strict
 * validation as the cloud-wins branch: a malformed or identity-inconsistent cloud document
 * rejects the whole sync *before* any ledger row, cursor move or local data replacement,
 * instead of being silently dropped and then declared complete.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./firebase", () => ({ firebaseAuth: { currentUser: null }, firebaseStorage: {}, firestore: {}, googleAuthProvider: {} }));

const fedStorageBoundary = vi.hoisted(() => ({ uploads: 0, downloads: 0 }));
vi.mock("firebase/storage", () => ({
  ref: (_storage: unknown, path: string) => ({ fullPath: path }),
  getMetadata: async () => { throw new Error("unexpected attachment metadata read"); },
  getBlob: async () => { fedStorageBoundary.downloads++; throw new Error("unexpected attachment download"); },
  uploadBytesResumable: () => { fedStorageBoundary.uploads++; throw new Error("unexpected attachment upload"); },
  deleteObject: vi.fn(), list: vi.fn(),
}));

const fedRemote = vi.hoisted(() => ({ documents: new Map<string, any>(), db: undefined as any }));
vi.mock('../db/database', async (importOriginal) => {
  const actual = await importOriginal<any>();
  const fake = await import('fake-indexeddb');
  const dexie = (await import('dexie')).default;
  dexie.dependencies.indexedDB = fake.indexedDB;
  dexie.dependencies.IDBKeyRange = fake.IDBKeyRange;
  return { ...actual, get db() { return fedRemote.db; } };
});
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<any>();
  const snap = (path: string) => ({ id: path.split('/').at(-1), exists: () => fedRemote.documents.has(path), data: () => structuredClone(fedRemote.documents.get(path)) });
  const getDocs = async (target: any) => {
    let rows = [...fedRemote.documents].filter(([path]) => path.startsWith(target.path + '/') && !path.slice(target.path.length + 1).includes('/'));
    for (const constraint of target.constraints ?? []) {
      if (constraint.kind !== 'where') continue;
      rows = rows.filter(([path, value]) => {
        const field = constraint.field === '__name__' ? path.split('/').at(-1) : value[constraint.field];
        return constraint.op === 'in' ? constraint.value.includes(field)
          : constraint.op === '>' ? field > constraint.value
          : constraint.op === '<' ? field < constraint.value
          : constraint.op === '<=' ? field <= constraint.value : field === constraint.value;
      });
    }
    const cap = target.constraints?.find((constraint: any) => constraint.kind === 'limit');
    if (cap) rows = rows.slice(0, cap.count);
    return { docs: rows.map(([path]) => snap(path)), size: rows.length, empty: rows.length === 0 };
  };
  return { ...actual, doc: (_db: any, ...parts: string[]) => ({ path: parts.join('/') }), collection: (_db: any, ...parts: string[]) => ({ path: parts.join('/') }), documentId: () => '__name__', where: (field: string, op: string, value: any) => ({ kind: 'where', field, op, value }), limit: (count: number) => ({ kind: 'limit', count }), orderBy: () => ({ kind: 'order' }), query: (target: any, ...constraints: any[]) => ({ ...target, constraints }), getDoc: async (target: any) => snap(target.path), getDocs, getCountFromServer: async (target: any) => ({ data: () => ({ count: [...fedRemote.documents.keys()].filter(path => path.startsWith(target.path + '/')).length }) }), runTransaction: async (_db: any, callback: any) => {
    const pending: any[] = [];
    const result = await callback({ get: async (target: any) => snap(target.path), set: (target: any, value: any) => pending.push([target.path, structuredClone(value)]) });
    for (const [path, value] of pending) fedRemote.documents.set(path, value);
    return result;
  } };
});

import { StudyJournalDatabase } from '../db/database';
import { DEFAULT_SETTINGS, DEFAULT_TAGS } from '../db/defaults';
import { exportCloudSync } from './cloudSyncModel';
import { CloudSnapshotIntegrityError } from './cloudSnapshotIntegrity';

const FED_UID = 'audit-user';
const fedStamp = '2026-09-21T00:00:00.000Z';
const fedSubject = (DEFAULT_SETTINGS as { subjects?: { name: string }[] }).subjects?.[0]?.name ?? '数学';
const fedRecord = (id: string) => ({
  id, type: 'record' as const, date: '2026-09-21', order: 0, subject: fedSubject,
  title: 'cloud record ' + id, contentHtml: '<p></p>', assets: [], formulas: [],
  mistakeRefs: [], tags: [], createdAt: fedStamp, updatedAt: fedStamp, favorite: false,
});

const fedOpenEmptyDevice = async (label: string) => {
  const device = new StudyJournalDatabase(`fed-${label}-${crypto.randomUUID()}`);
  await device.open();
  await device.settings.put(structuredClone(DEFAULT_SETTINGS));
  for (const name of DEFAULT_TAGS) {
    await device.tags.put({ id: `tag-${label}-${crypto.randomUUID()}`, name, createdAt: fedStamp, updatedAt: fedStamp });
  }
  return device;
};

const fedCloseDevice = async (device: StudyJournalDatabase) => {
  const Dexie = (await import('dexie')).default;
  device.close();
  await Dexie.delete(device.name);
};

/** Seed the remote exactly the way a device that already synced would leave it. */
const fedSeedCloud = async (source: StudyJournalDatabase) => {
  fedRemote.documents.clear();
  await source.blocks.bulkPut([fedRecord('one'), fedRecord('two')] as never[]);
  fedRemote.db = source;
  const { storage } = await import('./storageAdapter');
  const baseline = await exportCloudSync(await storage.createCloudSyncSnapshot());
  fedRemote.documents.set(`users/${FED_UID}/syncState/current`, {
    protocolVersion: 2, headRevision: 1, nextRevision: 1, lock: null,
    storageSummary: { revision: 1, assetObjectCount: 0, assetBytes: 0, payloadObjectCount: 0, payloadBytes: 0 },
  });
  for (const entity of baseline.entities) {
    fedRemote.documents.set(`users/${FED_UID}/syncEntities/${entity.key}`, { ...entity, revision: 1 });
  }
  return baseline;
};

describe('firstEmptyDevice destructive full replacement is strict (B-01)', () => {
  it('rejects a malformed cloud entity document before touching the new device', async () => {
    const source = await fedOpenEmptyDevice('source');
    const joiner = await fedOpenEmptyDevice('joiner');
    try {
      const baseline = await fedSeedCloud(source);
      const victimKey = [...baseline.entities].find((entity) => entity.entityType === 'block')!.key;
      const victim = structuredClone(fedRemote.documents.get(`users/${FED_UID}/syncEntities/${victimKey}`));
      delete victim.contentHash;
      fedRemote.documents.set(`users/${FED_UID}/syncEntities/${victimKey}`, victim);

      fedRemote.db = joiner;
      const service = await import('./cloudSyncService');
      const messages: string[] = [];
      await expect(service.synchronizeCloudChanges({ uid: FED_UID } as never, { onProgress: (p: { message?: string }) => { if (p.message) messages.push(p.message); } }))
        .rejects.toBeInstanceOf(CloudSnapshotIntegrityError);
      expect(messages.join('|')).not.toContain('已从云端恢复现有数据');

      // Nothing was replaced and no false completeness was advertised.
      expect(await joiner.blocks.count()).toBe(0);
      expect(await joiner.cloudSyncLedger.count()).toBe(0);
      const state = await joiner.cloudSyncState.get('state');
      expect(state?.lastPulledRevision).toBe(0);
      expect(state?.remoteDatasetCompleteThroughRevision).toBeUndefined();
      expect(fedStorageBoundary.uploads).toBe(0);
      expect(fedStorageBoundary.downloads).toBe(0);
    } finally {
      await fedCloseDevice(source);
      await fedCloseDevice(joiner);
    }
  }, 30_000);

  it('rejects a cloud document whose identity disagrees with its document id', async () => {
    const source = await fedOpenEmptyDevice('source');
    const joiner = await fedOpenEmptyDevice('joiner');
    try {
      await fedSeedCloud(source);
      // Tolerant parsing accepts this row (all required fields are present); only the strict
      // identity layer catches that document id and entity fields disagree.
      fedRemote.documents.set(`users/${FED_UID}/syncEntities/block:ghost`, {
        entityType: 'block', entityId: 'phantom', contentHash: 'hash-ghost', revision: 1,
        deleted: false, payload: { id: 'phantom' },
      });

      fedRemote.db = joiner;
      const service = await import('./cloudSyncService');
      await expect(service.synchronizeCloudChanges({ uid: FED_UID } as never)).rejects.toBeInstanceOf(CloudSnapshotIntegrityError);
      expect(await joiner.blocks.count()).toBe(0);
      expect(await joiner.cloudSyncLedger.count()).toBe(0);
      const state = await joiner.cloudSyncState.get('state');
      expect(state?.lastPulledRevision).toBe(0);
      expect(state?.remoteDatasetCompleteThroughRevision).toBeUndefined();
    } finally {
      await fedCloseDevice(source);
      await fedCloseDevice(joiner);
    }
  }, 30_000);

  it('positive control: a well-formed cloud set restores the new device and declares completeness', async () => {
    const source = await fedOpenEmptyDevice('source');
    const joiner = await fedOpenEmptyDevice('joiner');
    try {
      const baseline = await fedSeedCloud(source);
      fedRemote.db = joiner;
      const service = await import('./cloudSyncService');
      const messages: string[] = [];
      const result = await service.synchronizeCloudChanges({ uid: FED_UID } as never, { onProgress: (p: { message?: string }) => { if (p.message) messages.push(p.message); } });
      expect(result.kind).toBe('synced');
      if (result.kind !== 'synced') return;
      expect(result.uploaded).toBe(0);
      expect(result.downloaded).toBe(baseline.entities.length);
      expect(messages.join('|')).toContain('已从云端恢复现有数据');
      expect(await joiner.blocks.count()).toBe(2);
      expect(await joiner.cloudSyncLedger.count()).toBe(baseline.entities.length);
      const state = await joiner.cloudSyncState.get('state');
      expect(state?.lastPulledRevision).toBe(1);
      expect(state?.remoteDatasetCompleteThroughRevision).toBe(1);
    } finally {
      await fedCloseDevice(source);
      await fedCloseDevice(joiner);
    }
  }, 30_000);
});
