import { describe, expect, it, vi } from "vitest";
vi.mock("./firebase", () => ({ firebaseAuth: { currentUser: null }, firebaseStorage: {}, firestore: {}, googleAuthProvider: {} }));
const remote = vi.hoisted(() => ({
    documents: new Map<string, any>(),
    reads: 0,
    queries: 0,
    writes: 0,
    entityWrites: 0,
    queryLog: [] as Array<{ path: string; constraints: Array<{ kind: string; field?: string; op?: string; value?: unknown; count?: number }> }>,
    db: undefined as any,
    failPublishHead: false,
    failMetadataBatch: 0,
    metadataBatches: 0,
    failWriteBatch: 0,
    writeBatches: 0,
    failSnapshotCommitMarker: false,
}));
const storageProbe = vi.hoisted(() => ({ metadataCalls: 0, blobs: new Map<string, Blob>(), downloads: 0, objects: new Map<string, Set<string>>(), deleted: [] as string[] }));
vi.mock('firebase/storage', () => ({
    ref: (_storage: unknown, path: string) => ({ fullPath: path }),
    getMetadata: async () => { storageProbe.metadataCalls++; throw new Error('synthetic 检查云端资源超时'); },
    uploadBytesResumable: () => { throw new Error('unexpected upload'); },
    // Only objects the test itself put in Storage can be downloaded, so a path collision or a
    // missing object still fails loudly instead of silently returning an empty blob.
    getBlob: async (target: any) => {
        storageProbe.downloads++;
        const blob = storageProbe.blobs.get(target.fullPath);
        if (!blob) throw new Error('unexpected download');
        return blob;
    },
    // The GC path lists a root and deletes by reference. Objects are staged per root fullPath so a
    // test controls exactly what Storage holds, and every deletion is recorded for assertion. Before
    // this the two threw, so the irreversible delete branch had zero coverage.
    list: async (root: any) => {
        const names = storageProbe.objects.get(root.fullPath) ?? new Set<string>();
        return { items: [...names].map((name) => ({ name, fullPath: `${root.fullPath}/${name}` })), nextPageToken: undefined };
    },
    deleteObject: async (target: any) => {
        storageProbe.deleted.push(target.fullPath);
        const root = target.fullPath.slice(0, target.fullPath.lastIndexOf('/'));
        storageProbe.objects.get(root)?.delete(target.name);
    },
}));
vi.mock('../db/database', async (importOriginal) => {
    const actual = await importOriginal<any>();
    const fake = await import('fake-indexeddb');
    const dexie = (await import('dexie')).default;
    dexie.dependencies.indexedDB = fake.indexedDB;
    dexie.dependencies.IDBKeyRange = fake.IDBKeyRange;
    return { ...actual, get db() { return remote.db; } };
});
vi.mock('firebase/firestore', async (importOriginal) => {
    const actual = await importOriginal<any>();
    const snap = (path: string) => ({ id: path.split('/').at(-1), ref: { path }, exists: () => remote.documents.has(path), data: () => structuredClone(remote.documents.get(path)) });
    const getDocs = async (target: any) => {
        remote.queries++;
        remote.queryLog.push({ path: target.path, constraints: structuredClone(target.constraints ?? []) });
        let rows = [...remote.documents].filter(([path]) => path.startsWith(target.path + '/') && !path.slice(target.path.length + 1).includes('/'));
        for (const constraint of target.constraints ?? []) {
            if (constraint.kind !== 'where') continue;
            rows = rows.filter(([path, value]) => { const field = constraint.field === '__name__' ? path.split('/').at(-1) : value[constraint.field]; return constraint.op === 'in' ? constraint.value.includes(field) : constraint.op === '>' ? field > constraint.value : constraint.op === '<' ? field < constraint.value : constraint.op === '<=' ? field <= constraint.value : field === constraint.value; });
        }
        const cap = target.constraints?.find((constraint: any) => constraint.kind === 'limit');
        if (cap) rows = rows.slice(0, cap.count);
        remote.reads += rows.length;
        return { docs: rows.map(([path]) => snap(path)), size: rows.length, empty: rows.length === 0 };
    };
    return {
        ...actual,
        // `doc(firestore, ...parts)` builds a path from its arguments, while `doc(collectionRef, id)`
        // must extend the collection path. The mocked collection reference is the only object with a
        // `path`, so the two forms are distinguishable.
        doc: (parent: any, ...parts: string[]) => ({
            path: parent && typeof parent === 'object' && typeof parent.path === 'string'
                ? [parent.path, ...parts].join('/')
                : parts.join('/'),
        }),
        collection: (_db: any, ...parts: string[]) => ({ path: parts.join('/') }),
        documentId: () => '__name__',
        where: (field: string, op: string, value: any) => ({ kind: 'where', field, op, value }),
        limit: (count: number) => ({ kind: 'limit', count }),
        orderBy: () => ({ kind: 'order' }),
        query: (target: any, ...constraints: any[]) => ({ ...target, constraints }),
        getDoc: async (target: any) => { remote.reads++; return snap(target.path); },
        getDocs,
        setDoc: async (target: any, value: any) => {
            if (remote.failSnapshotCommitMarker) {
                remote.failSnapshotCommitMarker = false;
                throw new Error('synthetic snapshot commit marker failure');
            }
            remote.documents.set(target.path, structuredClone(value));
            remote.writes++;
        },
        writeBatch: () => {
            const pending: Array<[string, any]> = [];
            const deletes: string[] = [];
            return {
                set: (target: any, value: any) => { pending.push([target.path, value]); },
                delete: (target: any) => { deletes.push(target.path); },
                commit: async () => {
                    remote.writeBatches++;
                    if (remote.failWriteBatch === remote.writeBatches) throw new Error('synthetic snapshot batch failure');
                    for (const [path, value] of pending) { remote.documents.set(path, structuredClone(value)); remote.writes++; }
                    for (const path of deletes) remote.documents.delete(path);
                },
            };
        },
        getCountFromServer: async (target: any) => {
            // Mirror getDocs: a count query must honor its where/limit constraints, otherwise a
            // same-predicate count proof compares a filtered read against a whole-collection count and
            // can never detect a dropped document. Bare collection refs (no constraints) still count
            // every document under the prefix, so the GC count paths are unchanged.
            let rows = [...remote.documents].filter(([path]) => path.startsWith(target.path + '/'));
            for (const constraint of target.constraints ?? []) {
                if (constraint.kind !== 'where') continue;
                rows = rows.filter(([path, value]) => { const field = constraint.field === '__name__' ? path.split('/').at(-1) : value[constraint.field]; return constraint.op === 'in' ? constraint.value.includes(field) : constraint.op === '>' ? field > constraint.value : constraint.op === '<' ? field < constraint.value : constraint.op === '<=' ? field <= constraint.value : field === constraint.value; });
            }
            const cap = target.constraints?.find((constraint: any) => constraint.kind === 'limit');
            if (cap) rows = rows.slice(0, cap.count);
            return { data: () => ({ count: rows.length }) };
        },
        runTransaction: async (_db: any, callback: any) => {
            const pending: any[] = [];
            const result = await callback({ get: async (target: any) => { remote.reads++; return snap(target.path); }, set: (target: any, value: any) => pending.push([target.path, structuredClone(value)]) });
            if (pending.some(([path]) => path.includes('/syncEntities/') || path.includes('/syncReviewEvents/'))) {
                remote.metadataBatches++;
                if (remote.metadataBatches === remote.failMetadataBatch) throw new Error('synthetic metadata batch failure');
            }
            for (const [path, value] of pending) {
                if (remote.failPublishHead && path.endsWith('/syncState/current') && value.headRevision === 2 && value.lock === null) {
                    remote.failPublishHead = false;
                    throw new Error('synthetic head commit failure');
                }
                remote.documents.set(path, value);
                remote.writes++;
                if (path.includes('/syncEntities/') || path.includes('/syncReviewEvents/')) remote.entityWrites++;
            }
            return result;
        },
    };
});
import { StudyJournalDatabase as WhiteboxDatabase } from '../db/database';
import { storage as whiteboxStorage } from './storageAdapter';
import { exportCloudSync as whiteboxExport, hashBlob as whiteboxHashBlob } from './cloudSyncModel';
import { DEFAULT_SETTINGS as whiteboxDefaults } from '../db/defaults';

const UID = 'wb-user';
const stamp = '2026-09-21T00:00:00.000Z';
const subject = whiteboxDefaults.subjects?.[0]?.name ?? '数学';

const block = (id: string, title = 'base ' + id) => ({
    id, type: 'record', date: '2026-09-21', order: 0, subject, title,
    contentHtml: '<p></p>', assets: [], formulas: [], mistakeRefs: [], tags: [],
    createdAt: stamp, updatedAt: stamp, favorite: false,
});

const entityDoc = (key: string, entityId: string, payload: any, revision: number, deleted = false) => ({
    key, entityType: 'block', entityId, payload, deleted, revision,
    contentHash: 'hash-' + key, contentHashVersion: 1, contentHashAlgorithm: 'fnv1a', updatedAt: stamp,
});

const stateDoc = (headRevision: number, nextRevision = headRevision, lock: any = null) => ({
    protocolVersion: 2, headRevision, nextRevision, lock,
});

async function boot(options: { completeThrough?: number | null | undefined } = {}) {
    remote.documents.clear();
    remote.reads = 0;
    remote.queries = 0;
    remote.writes = 0;
    remote.entityWrites = 0;
    remote.queryLog = [];
    remote.failPublishHead = false;
    remote.failMetadataBatch = 0;
    remote.metadataBatches = 0;
    remote.failWriteBatch = 0;
    remote.writeBatches = 0;
    remote.failSnapshotCommitMarker = false;
    storageProbe.blobs.clear();
    storageProbe.downloads = 0;
    storageProbe.objects.clear();
    storageProbe.deleted.length = 0;
    const devices = [new WhiteboxDatabase('wb-phone-' + crypto.randomUUID()), new WhiteboxDatabase('wb-desktop-' + crypto.randomUUID())];
    for (const database of devices) {
        await database.open();
        await database.blocks.bulkPut([block('one'), block('two')] as any);
        await database.settings.put(structuredClone(whiteboxDefaults));
    }
    remote.db = devices[0];
    const baseline = await whiteboxExport(await whiteboxStorage.createCloudSyncSnapshot());
    for (const database of devices) {
        await database.cloudSyncState.put({
            id: 'state', deviceId: database.name, userId: UID,
            lastPulledRevision: 1, lastReviewEventRevision: 1,
            ...(options.completeThrough === null ? {} : { remoteDatasetCompleteThroughRevision: options.completeThrough ?? 1 }),
        } as any);
        await database.cloudSyncLedger.bulkPut(baseline.entities.map((entity) => ({
            id: entity.key, entityType: entity.entityType, entityId: entity.entityId,
            contentHash: entity.contentHash, contentHashVersion: entity.contentHashVersion,
            contentHashAlgorithm: entity.contentHashAlgorithm, cloudRevision: 1,
            basePayload: entity.entityType === 'settings' ? entity.payload : undefined,
        })) as any);
    }
    remote.documents.set(`users/${UID}/syncState/current`, stateDoc(1));
    for (const entity of baseline.entities) remote.documents.set(`users/${UID}/syncEntities/${entity.key}`, { ...entity, revision: 1 });
    return devices;
}

async function close(devices: any[]) {
    const Dexie = (await import('dexie')).default;
    for (const database of devices) { database.close(); await Dexie.delete(database.name); }
}

/** Use a device as "the one running sync" and then put it back. */
async function use<T>(index: number, devices: any[], work: () => Promise<T>): Promise<T> {
    remote.db = devices[index];
    return work();
}

async function sync(devices: any[], index: number) {
    const service = await import('./cloudSyncService');
    return use(index, devices, () => service.synchronizeCloudChanges({ uid: UID } as any));
}

const currentRemoteEntity = (key: string) => remote.documents.get(`users/${UID}/syncEntities/${key}`);


for (const authorIndex of [0, 1]) {
    it('preserves a cloud deletion during background reclaim direction ' + authorIndex, async () => {
        const devices = await boot();
        const receiverIndex = 1 - authorIndex;
        try {
            remote.db = devices[authorIndex];
            await whiteboxStorage.saveBlock(block('shell') as any);
            await whiteboxStorage.saveDailyPlan({ id: 'p', date: '2026-09-21', subject, title: 'plan', order: 0, createdAt: stamp, updatedAt: stamp, linkedRecordId: 'shell' });
            await sync(devices, authorIndex);
            await sync(devices, receiverIndex);
            const oldPlan = (await devices[receiverIndex].dailyPlans.get('p'))!;
            remote.db = devices[authorIndex];
            await whiteboxStorage.deleteDailyPlan('p');
            await sync(devices, authorIndex);
            remote.db = devices[receiverIndex];
            const database = devices[receiverIndex];
            const original = database.transaction.bind(database);
            let injected = false;
            let deletedPlan: unknown;
            const hook = vi.spyOn(database, 'transaction').mockImplementation((async (...args: any[]) => {
                if (!injected) {
                    injected = true;
                    await sync(devices, receiverIndex);
                    deletedPlan = await database.dailyPlans.get('p');
                }
                return (original as any)(...args);
            }) as any);
            try {
                expect(await whiteboxStorage.reclaimEmptyPlanRecords()).toEqual(['shell']);
            } finally { hook.mockRestore(); }
            expect(injected).toBe(true);
            expect(await database.dailyPlans.get('p')).toEqual(deletedPlan);
            expect((await database.dailyPlans.get('p'))!.deletedAt).toBeTruthy();
            const epoch = await whiteboxStorage.getCloudSyncMutationEpoch();
            await expect(whiteboxStorage.saveDailyPlan(oldPlan)).rejects.toThrow('计划已删除');
            expect(await whiteboxStorage.getCloudSyncMutationEpoch()).toBe(epoch);
            const before = remote.entityWrites;
            expect(await sync(devices, receiverIndex)).toMatchObject({ kind: 'synced', uploaded: 1 });
            expect(remote.entityWrites - before).toBe(1);
            await sync(devices, authorIndex);
            expect((await devices[authorIndex].dailyPlans.get('p'))!.deletedAt).toBeTruthy();
            const stable = { writes: remote.writes, queries: remote.queries };
            expect(await sync(devices, receiverIndex)).toMatchObject({ uploaded: 0, downloaded: 0 });
            expect(await sync(devices, authorIndex)).toMatchObject({ uploaded: 0, downloaded: 0 });
            expect({ writes: remote.writes, queries: remote.queries }).toEqual(stable);
        } finally { await close(devices); }
    });
}

describe('W-01 values() soft-delete retention scope', () => {
    it('materialises soft-deleted payloads, drops bare tombstones, and converges', async () => {
        const devices = await boot();
        try {
            remote.documents.set(`users/${UID}/syncEntities/block:soft-1`, entityDoc('block:soft-1', 'soft-1', { ...block('soft-1'), deletedAt: stamp }, 2, true));
            remote.documents.set(`users/${UID}/syncEntities/block:tomb-1`, entityDoc('block:tomb-1', 'tomb-1', { id: 'tomb-1' }, 2, true));
            remote.documents.set(`users/${UID}/syncEntities/block:empty-1`, entityDoc('block:empty-1', 'empty-1', { ...block('empty-1'), deletedAt: '' }, 2, true));
            remote.documents.set(`users/${UID}/syncState/current`, stateDoc(2));

            await sync(devices, 1);

            expect(await devices[1].blocks.get('soft-1')).toMatchObject({ id: 'soft-1', deletedAt: stamp });
            expect(await devices[1].blocks.get('tomb-1')).toBeUndefined();
            expect(await devices[1].blocks.get('empty-1')).toBeUndefined();
            const live = (await whiteboxStorage.listBlocks()).map((item: any) => item.id);
            expect(live).not.toContain('empty-1');

            const next = await sync(devices, 1);
            expect(next).toMatchObject({ kind: 'synced', uploaded: 0 });
            const back = await sync(devices, 0);
            expect(back).toMatchObject({ kind: 'synced', uploaded: 0, downloaded: 3 });
            const stable = { writes: remote.writes, queries: remote.queries };
            expect(await sync(devices, 1)).toMatchObject({ uploaded: 0, downloaded: 0 });
            expect(await sync(devices, 0)).toMatchObject({ uploaded: 0, downloaded: 0 });
            expect({ writes: remote.writes, queries: remote.queries }).toEqual(stable);
        } finally { await close(devices); }
    });
});

describe('W-02 dirty remote payload robustness', () => {
    it('does not let one malformed remote document break the whole materialisation', async () => {
        const devices = await boot();
        try {
            remote.documents.set(`users/${UID}/syncEntities/block:broken-null`, entityDoc('block:broken-null', 'broken-null', null, 2, true));
            remote.documents.set(`users/${UID}/syncEntities/block:broken-missing`, { key: 'block:broken-missing', entityType: 'block', entityId: 'broken-missing', deleted: true, revision: 2, contentHash: 'h', contentHashVersion: 1, contentHashAlgorithm: 'fnv1a' });
            remote.documents.set(`users/${UID}/syncEntities/block:good-1`, entityDoc('block:good-1', 'good-1', { ...block('good-1') }, 2, false));
            remote.documents.set(`users/${UID}/syncState/current`, stateDoc(2));

            let failure: unknown;
            try { await sync(devices, 1); } catch (error) { failure = error; }
            expect(failure).toBeUndefined();
            expect(await devices[1].blocks.get('good-1')).toBeDefined();

            // Recoverability: even a defensive failure must not be permanent.
            remote.documents.delete(`users/${UID}/syncEntities/block:broken-null`);
            remote.documents.delete(`users/${UID}/syncEntities/block:broken-missing`);
            expect(await sync(devices, 1)).toMatchObject({ kind: 'synced' });
        } finally { await close(devices); }
    });
});

describe('W-04 targeted reconciliation must not skip unread revisions', () => {
    it('still delivers an unread lower revision that sits behind an unknown operation', async () => {
        const devices = await boot();
        try {
            const own = await (async () => { remote.db = devices[0]; return whiteboxExport(await whiteboxStorage.createCloudSyncSnapshot()); })();
            const ownOne = own.entities.find((entity) => entity.key === 'block:one')!;
            // Remote head reached 3: an unrelated brand-new record landed at revision 2 while this
            // device's own operation stalled at revision 3 (whose content is already committed).
            remote.documents.set(`users/${UID}/syncEntities/block:extra`, entityDoc('block:extra', 'extra', { ...block('extra', 'unread revision 2') }, 2, false));
            remote.documents.set(`users/${UID}/syncEntities/block:one`, { ...ownOne, revision: 3 });
            remote.documents.set(`users/${UID}/syncState/current`, stateDoc(3, 3));
            await devices[0].cloudSyncOperations.put({
                id: 'stall', operationId: 'stall', userId: UID, deviceId: devices[0].name, revision: 3,
                previousHeadRevision: 1, expectedEntities: [{ key: 'block:one', contentHash: ownOne.contentHash }], expectedEvents: [],
                phase: 'releasing', status: 'unknown', createdAt: stamp, updatedAt: stamp,
            } as any);

            const result = await sync(devices, 0);

            expect(await devices[0].cloudSyncOperations.get('stall')).toMatchObject({ status: 'succeeded' });
            expect(await devices[0].blocks.get('extra')).toMatchObject({ title: 'unread revision 2' });
            const state = await devices[0].cloudSyncState.get('state');
            expect(state!.lastPulledRevision).toBe(3);
            const repeat = await sync(devices, 0);
            expect(repeat).toMatchObject({ kind: 'synced', uploaded: 0, downloaded: 0 });
            expect(result.kind).toBe('synced');
        } finally { await close(devices); }
    });
});

describe('W-05 ledger revision labels must not regress', () => {
    it('keeps cloudRevision consistent with the content hash it records', async () => {
        const devices = await boot();
        try {
            const own = await (async () => { remote.db = devices[0]; return whiteboxExport(await whiteboxStorage.createCloudSyncSnapshot()); })();
            remote.documents.set(`users/${UID}/syncEntities/block:extra`, entityDoc('block:extra', 'extra', { ...block('extra', 'landed at 5') }, 5, false));
            remote.documents.set(`users/${UID}/syncState/current`, stateDoc(5, 5));
            await sync(devices, 0);
            const atFive = await devices[0].cloudSyncLedger.get('block:extra');
            expect(atFive).toMatchObject({ cloudRevision: 5 });
            expect(own.entities.length).toBeGreaterThan(0);

            // A stale unknown operation from revision 2 is reconciled later, while the live
            // document already sits at revision 5.
            await devices[0].cloudSyncOperations.put({
                id: 'stale-2', operationId: 'stale-2', userId: UID, deviceId: devices[0].name, revision: 2,
                previousHeadRevision: 1, expectedEntities: [{ key: 'block:extra', contentHash: atFive!.contentHash }], expectedEvents: [],
                phase: 'uploading', status: 'unknown', createdAt: stamp, updatedAt: stamp,
            } as any);
            await sync(devices, 0);

            // `cloudRevision` is copied from the remote document's own revision, so a stale
            // operation cannot drag the label backwards even though it passes its own revision in.
            const ledger = await devices[0].cloudSyncLedger.get('block:extra');
            expect(ledger!.cloudRevision).toBeGreaterThanOrEqual(5);
            expect(ledger!.contentHash).toBe(atFive!.contentHash);
        } finally { await close(devices); }
    });
});

describe('W-06 empty-delta cursor advancement preconditions', () => {
    it('advances a verified empty delta and then costs no queries', async () => {
        const devices = await boot();
        try {
            remote.documents.set(`users/${UID}/syncState/current`, stateDoc(2, 2));
            await sync(devices, 0);
            expect((await devices[0].cloudSyncState.get('state'))!.lastPulledRevision).toBe(2);
            const before = { queries: remote.queries, writes: remote.writes };
            expect(await sync(devices, 0)).toMatchObject({ kind: 'synced', uploaded: 0, downloaded: 0 });
            expect(remote.queries).toBe(before.queries);
            expect(remote.writes).toBe(before.writes);
        } finally { await close(devices); }
    });

    it('does not fake dataset completeness while advancing the cursor', async () => {
        const devices = await boot({ completeThrough: null });
        try {
            remote.documents.set(`users/${UID}/syncState/current`, stateDoc(2, 2));
            await sync(devices, 0);
            const state = await devices[0].cloudSyncState.get('state');
            expect(state!.lastPulledRevision).toBe(2);
            expect(state!.remoteDatasetCompleteThroughRevision).toBeUndefined();
        } finally { await close(devices); }
    });

    it('never moves the cursor backwards when the device is ahead', async () => {
        const devices = await boot();
        try {
            for (const database of devices) await database.cloudSyncState.put({ ...(await database.cloudSyncState.get('state'))!, lastPulledRevision: 3, lastReviewEventRevision: 3, remoteDatasetCompleteThroughRevision: 3 } as any);
            remote.documents.set(`users/${UID}/syncState/current`, stateDoc(2, 2));
            await sync(devices, 0);
            expect((await devices[0].cloudSyncState.get('state'))!.lastPulledRevision).toBe(3);
        } finally { await close(devices); }
    });
});

describe('W-07 hidden-revision guard range and short-circuit', () => {
    it('short-circuits on the ordinary head+1 case without any gap query', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            await whiteboxStorage.saveBlock({ ...block('one', 'normal edit') } as any);
            const before = remote.queryLog.length;
            const result = await sync(devices, 0);
            const gapQueries = remote.queryLog.slice(before).filter((entry) => entry.constraints.some(constraint => constraint.kind === 'where' && constraint.field === 'revision' && constraint.op === '>') && entry.constraints.some(constraint => constraint.kind === 'limit' && constraint.count === 1));
            expect(gapQueries).toEqual([]);
            expect(result).toMatchObject({ kind: 'synced' });
        } finally { await close(devices); }
    });

    it('detects a hidden entity revision and refuses to publish over it', async () => {
        const devices = await boot();
        try {
            remote.documents.set(`users/${UID}/syncEntities/block:one`, { ...currentRemoteEntity('block:one'), revision: 2, contentHash: 'hidden-hash' });
            remote.documents.set(`users/${UID}/syncState/current`, stateDoc(1, 2));
            remote.db = devices[1];
            await whiteboxStorage.saveBlock({ ...block('two', 'B independent edit') } as any);
            await expect(sync(devices, 1)).rejects.toThrow('尚未确认的同步写入');
            expect(currentRemoteEntity('block:one').contentHash).toBe('hidden-hash');
            expect((await devices[1].cloudSyncState.get('state'))!.lastPulledRevision).toBe(1);
        } finally { await close(devices); }
    });

    it('detects a hidden review event revision', async () => {
        const devices = await boot();
        try {
            remote.documents.set(`users/${UID}/syncReviewEvents/evt-1`, { id: 'evt-1', key: 'evt-1', contentHash: 'h', revision: 2, updatedAt: stamp });
            remote.documents.set(`users/${UID}/syncState/current`, stateDoc(1, 2));
            remote.db = devices[1];
            await whiteboxStorage.saveBlock({ ...block('two', 'B edit') } as any);
            await expect(sync(devices, 1)).rejects.toThrow('尚未确认的同步写入');
        } finally { await close(devices); }
    });

    it('allows publishing when the gap range is empty', async () => {
        const devices = await boot();
        try {
            remote.documents.set(`users/${UID}/syncState/current`, stateDoc(1, 2));
            remote.db = devices[1];
            await whiteboxStorage.saveBlock({ ...block('two', 'B edit, empty gap') } as any);
            expect(await sync(devices, 1)).toMatchObject({ kind: 'synced', uploaded: 1 });
            const gapQueries = remote.queryLog.filter(entry => entry.constraints.some(constraint => constraint.kind === 'limit' && constraint.count === 1));
            expect(gapQueries).toHaveLength(2);
            for (const entry of gapQueries) {
                expect(entry.constraints).toEqual(expect.arrayContaining([
                    { kind: 'where', field: 'revision', op: '>', value: 1 },
                    { kind: 'where', field: 'revision', op: '<', value: 3 },
                    { kind: 'limit', count: 1 },
                ]));
            }
        } finally { await close(devices); }
    });
});

describe('W-08 cleanup and classification of a guard rejection', () => {
    it('releases the lock, records a terminal operation, and is not mistaken for a timeout', async () => {
        const devices = await boot();
        try {
            remote.documents.set(`users/${UID}/syncEntities/block:one`, { ...currentRemoteEntity('block:one'), revision: 2, contentHash: 'hidden-hash' });
            remote.documents.set(`users/${UID}/syncState/current`, stateDoc(1, 2));
            remote.db = devices[1];
            await whiteboxStorage.saveBlock({ ...block('two', 'B edit') } as any);

            let message = '';
            try { await sync(devices, 1); } catch (error) { message = (error as Error).message; }

            expect(message).toContain('尚未确认的同步写入');
            expect(/超时|timeout/i.test(message)).toBe(false);
            expect(remote.documents.get(`users/${UID}/syncState/current`).lock).toBeNull();
            const operations = await devices[1].cloudSyncOperations.toArray();
            expect(operations.length).toBeGreaterThan(0);
            for (const operation of operations) {
                expect(['failed', 'succeeded', 'superseded']).toContain(operation.status);
            }
        } finally { await close(devices); }
    });
});

describe('W-09 partial commit reconciliation', () => {
    it('records only the matched subset and uploads just the remainder', async () => {
        const devices = await boot();
        try {
            // The third record exists locally but never reached the cloud.
            await devices[0].blocks.put(block('three') as any);
            const own = await (async () => { remote.db = devices[0]; return whiteboxExport(await whiteboxStorage.createCloudSyncSnapshot()); })();
            const hashOf = (key: string) => own.entities.find((entity) => entity.key === key)!.contentHash;
            remote.documents.set(`users/${UID}/syncEntities/block:one`, { ...currentRemoteEntity('block:one'), revision: 2, contentHash: hashOf('block:one') });
            remote.documents.set(`users/${UID}/syncEntities/block:two`, { ...currentRemoteEntity('block:two'), revision: 2, contentHash: hashOf('block:two') });
            remote.documents.set(`users/${UID}/syncState/current`, stateDoc(1, 2));
            await devices[0].cloudSyncOperations.put({
                id: 'partial', operationId: 'partial', userId: UID, deviceId: devices[0].name, revision: 2,
                previousHeadRevision: 1,
                expectedEntities: [{ key: 'block:one', contentHash: hashOf('block:one') }, { key: 'block:two', contentHash: hashOf('block:two') }, { key: 'block:three', contentHash: hashOf('block:three') }],
                expectedEvents: [], phase: 'committing', status: 'unknown', createdAt: stamp, updatedAt: stamp,
            } as any);

            const result = await sync(devices, 0);

            const operation = await devices[0].cloudSyncOperations.get('partial');
            expect(operation!.reconciliationReason).toContain('部分提交');
            // The partial branch must claim only the two committed keys, at the stalled revision.
            expect((await devices[0].cloudSyncLedger.get('block:one'))!.cloudRevision).toBe(2);
            expect((await devices[0].cloudSyncLedger.get('block:two'))!.cloudRevision).toBe(2);
            // The uncommitted key must be recorded at the revision it was actually published at,
            // never at the stalled operation's revision.
            expect((await devices[0].cloudSyncLedger.get('block:three'))!.cloudRevision).toBeGreaterThan(2);
            expect(result).toMatchObject({ kind: 'synced', uploaded: 1 });
            expect(currentRemoteEntity('block:one').contentHash).toBe(hashOf('block:one'));
            expect(currentRemoteEntity('block:one').revision).toBe(2);
            expect(currentRemoteEntity('block:three').revision).toBe(4);

            remote.db = devices[1];
            expect(await sync(devices, 1)).toMatchObject({ kind: 'synced', uploaded: 0, downloaded: 3 });
            expect(await devices[1].blocks.get('three')).toBeDefined();
            expect(await sync(devices, 1)).toMatchObject({ kind: 'synced', uploaded: 0, downloaded: 0 });
        } finally { await close(devices); }
    });
});

describe('W-10 publish failure classification', () => {
    it('preserves the unknown-operation guard when Storage times out before metadata starts', async () => {
        const devices = await boot();
        storageProbe.metadataCalls = 0;
        try {
            remote.db = devices[0];
            await devices[0].blocks.put({ ...block('large'), contentHtml: '<p>' + 'x'.repeat(800 * 1024) + '</p>' } as any);
            expect(await sync(devices, 0)).toMatchObject({ kind: 'uncertain' });
            expect(storageProbe.metadataCalls).toBe(1);
            expect(remote.metadataBatches).toBe(0);
            const operations = await devices[0].cloudSyncOperations.toArray();
            expect(operations.some(operation => operation.status === 'unknown' && operation.phase === 'uploading')).toBe(true);
        } finally { await close(devices); }
    });
    it('keeps the operation unknown when a metadata batch fails mid-flight', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            await devices[0].blocks.bulkPut(Array.from({ length: 401 }, (_, index) => block('bulk-' + index)) as any);
            remote.failMetadataBatch = 2;
            expect(await sync(devices, 0)).toMatchObject({ kind: 'uncertain' });
            expect(remote.documents.get(`users/${UID}/syncState/current`).lock).toBeNull();
        } finally { await close(devices); }
    });

    it('makes committed metadata visible when the head commit fails', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            await whiteboxStorage.saveBlock({ ...block('one', 'metadata committed') } as any);
            remote.failPublishHead = true;
            expect(await sync(devices, 0)).toMatchObject({ kind: 'uncertain' });
            expect(remote.documents.get(`users/${UID}/syncState/current`).headRevision).toBe(2);
            expect(currentRemoteEntity('block:one').revision).toBe(2);
            expect(remote.documents.get(`users/${UID}/syncState/current`).lock).toBeNull();
        } finally { await close(devices); }
    });
});

describe('W-11 lock release semantics after a partial publish', () => {
    it('lets another device receive metadata that was committed before the head failure', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            await whiteboxStorage.saveBlock({ ...block('one', 'A metadata committed') } as any);
            remote.failPublishHead = true;
            expect(await sync(devices, 0)).toMatchObject({ kind: 'uncertain' });

            remote.db = devices[1];
            await sync(devices, 1);
            expect(await devices[1].blocks.get('one')).toMatchObject({ title: 'A metadata committed' });
            remote.db = devices[0];
            // Observation: the publishing device re-imports its own committed content once
            // (downloaded 1), because the failed publish never wrote its ledger. Content is
            // identical, and it must still converge.
            const returned = await sync(devices, 0);
            expect(returned).toMatchObject({ kind: 'synced', uploaded: 0 });
            expect(await devices[0].blocks.get('one')).toMatchObject({ title: 'A metadata committed' });
            expect(await sync(devices, 0)).toMatchObject({ kind: 'synced', uploaded: 0, downloaded: 0 });
            remote.db = devices[1];
            expect(await sync(devices, 1)).toMatchObject({ kind: 'synced', uploaded: 0, downloaded: 0 });
        } finally { await close(devices); }
    });
});

describe('W-12 the self-healing claim does not hold across two devices', () => {
    it('does not re-upload content that the other device already imported', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            await whiteboxStorage.saveBlock({ ...block('one', 'A uploads once') } as any);
            const first = await sync(devices, 0);
            expect(first).toMatchObject({ kind: 'synced', uploaded: 1 });
            const revisionAfterUpload = currentRemoteEntity('block:one').revision;
            const writesAfterUpload = remote.entityWrites;

            remote.db = devices[1];
            expect(await sync(devices, 1)).toMatchObject({ kind: 'synced', downloaded: 1 });

            remote.db = devices[0];
            const second = await sync(devices, 0);
            expect(second).toMatchObject({ kind: 'synced', uploaded: 0 });
            expect(currentRemoteEntity('block:one').revision).toBe(revisionAfterUpload);
            expect(remote.entityWrites).toBe(writesAfterUpload);
        } finally { await close(devices); }
    });
});

describe('W-28 voice session lifecycle after a full restore', () => {
    it('does not recreate a restored-away session and still allows a new one', async () => {
        const devices = await boot();
        let runtime: any;
        try {
            const { VoiceRecallRuntimeController } = await import('../features/voiceRecall/runtimeController');
            const { VoiceRecallRepository } = await import('../features/voiceRecall/repository');
            remote.db = devices[0];
            const snapshot = await whiteboxStorage.createCloudSyncSnapshot();
            const repository = new VoiceRecallRepository(devices[0]);
            runtime = new VoiceRecallRuntimeController(repository);
            const id = await runtime.createSession({ mode: 'scope-practice', source: { kind: 'review-card', recordIds: ['one'] }, inputMode: 'auto-half-duplex' });
            runtime.dispatch({ type: 'OPEN_PREFLIGHT' });
            runtime.dispatch({ type: 'CONFIRM_DISCLOSURE', confirmed: true });
            runtime.dispatch({ type: 'CONNECT' });
            runtime.dispatch({ type: 'CONNECTED' });

            await whiteboxStorage.restoreSnapshot(snapshot);
            expect(await devices[0].voiceRecallSessions.get(id)).toBeUndefined();

            const epoch = await whiteboxStorage.getCloudSyncMutationEpoch();
            await runtime.pause();
            await runtime.pause();
            expect(await devices[0].voiceRecallSessions.get(id)).toBeUndefined();
            expect(await whiteboxStorage.getCloudSyncMutationEpoch()).toBe(epoch);
            expect(JSON.stringify((await whiteboxExport(await whiteboxStorage.createCloudSyncSnapshot())).entities)).not.toContain(id);

            // A brand new session must still be creatable, and end() must tolerate the cleared state.
            const fresh = await runtime.createSession({ mode: 'scope-practice', source: { kind: 'review-card', recordIds: ['one'] }, inputMode: 'auto-half-duplex' });
            expect(await devices[0].voiceRecallSessions.get(fresh)).toBeDefined();
            await runtime.end();
            runtime = undefined;
        } finally { await runtime?.end(); await close(devices); }
    });
});

const snapshotParentPath = (id: string) => `users/${UID}/syncSnapshots/${id}`;
const snapshotChild = (id: string, docId: string, value: any) =>
    remote.documents.set(`${snapshotParentPath(id)}/entities/${docId}`, value);
const allSnapshotParents = () =>
    [...remote.documents.keys()].filter((path) => /\/syncSnapshots\/[^/]+$/.test(path));
const allSnapshotChildren = (id?: string) =>
    [...remote.documents.keys()].filter((path) =>
        id === undefined ? /\/syncSnapshots\/[^/]+\/entities\//.test(path) : path.startsWith(`${snapshotParentPath(id)}/entities/`));

async function localBookkeeping(device: any) {
    return {
        state: structuredClone(await device.cloudSyncState.get('state')),
        ledger: structuredClone(await device.cloudSyncLedger.toArray()),
    };
}

const blockIds = async (device: any) => (await device.blocks.toArray()).map((item: any) => item.id).sort();

const aggressive = { allowExpensiveRead: true, allowExpensiveWrite: true };

describe('SNAP cloud recovery snapshot completeness', () => {
    it('SNAP-01: a failed batch leaves no listable recovery point, and the orphan children stay unreachable', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            const service = await import('./cloudSyncService');
            const user = { uid: UID } as any;

            expect(await service.resolveCloudSyncConflict(user, 'local', aggressive)).toMatchObject({ kind: 'synced' });
            const listed = await service.listCloudRecoverySnapshots(UID);
            expect(listed).toHaveLength(1);
            expect(listed[0].status).toBe('complete');
            expect(listed[0].entityCount).toBeGreaterThan(0);

        const beforeParentCount = allSnapshotParents().length;
        remote.failWriteBatch = remote.writeBatches + 1;
        await expect(service.resolveCloudSyncConflict(user, 'local', aggressive)).rejects.toThrow('synthetic snapshot batch failure');
        remote.failWriteBatch = 0;

        // A failed batch commits nothing at all, so no recovery point — complete or not — is added.
        expect(allSnapshotParents()).toHaveLength(beforeParentCount);
        const after = await service.listCloudRecoverySnapshots(UID);
        expect(after.map((item) => item.id)).toEqual([listed[0].id]);
        expect(after[0].status).toBe('complete');
        expect(allSnapshotChildren(listed[0].id).length).toBe(listed[0].entityCount);
        // The earlier complete recovery point is still restorable.
        await expect(service.restoreCloudRecoverySnapshot(user, listed[0].id)).resolves.toMatchObject({ status: 'complete' });
    } finally { await close(devices); }
});

it('SNAP-01b: a partial multi-batch snapshot is unreachable and does not disturb the previous recovery point', async () => {
    const devices = await boot();
    try {
        remote.db = devices[0];
        const service = await import('./cloudSyncService');
        const user = { uid: UID } as any;

        expect(await service.resolveCloudSyncConflict(user, 'local', aggressive)).toMatchObject({ kind: 'synced' });
        const good = (await service.listCloudRecoverySnapshots(UID))[0];
        const goodChildren = allSnapshotChildren(good.id).length;

        // Push the recovery snapshot over one Firestore write batch (400 documents) so that the first
        // batch lands and the second one fails, which is how a partially written snapshot appears.
        for (let index = 0; index < 405; index += 1) {
            const key = `block:bulk-${index}`;
            remote.documents.set(`users/${UID}/syncEntities/${key}`, {
                key, entityType: 'block', entityId: `bulk-${index}`,
                payload: { ...block(`bulk-${index}`), id: `bulk-${index}` },
                deleted: false, revision: 2, contentHash: `hash-${key}`,
                contentHashAlgorithm: 'sha256', contentHashVersion: 2, updatedAt: stamp,
            });
        }
        remote.documents.set(`users/${UID}/syncState/current`, stateDoc(2, 2));

        remote.failWriteBatch = remote.writeBatches + 2;
        await expect(service.resolveCloudSyncConflict(user, 'local', aggressive)).rejects.toThrow('synthetic snapshot batch failure');
        remote.failWriteBatch = 0;

        // Orphan children landed, but no parent document can advertise them.
        expect(allSnapshotParents()).toHaveLength(1);
        expect(allSnapshotChildren().length).toBeGreaterThan(goodChildren);
        const listed = await service.listCloudRecoverySnapshots(UID);
        expect(listed.map((item) => item.id)).toEqual([good.id]);
        expect(listed[0].status).toBe('complete');
        await expect(service.restoreCloudRecoverySnapshot(user, good.id)).resolves.toMatchObject({ status: 'complete', entityCount: good.entityCount });
    } finally { await close(devices); }
});

    it('SNAP-02: legacy snapshots keep their historical ability only when the recorded count is provable', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            const service = await import('./cloudSyncService');
            const user = { uid: UID } as any;

            remote.documents.set(snapshotParentPath('writing-1'), { createdAt: stamp, label: '半成品', entityCount: 2, revision: 2, complete: false });
            snapshotChild('writing-1', 'block:w1', entityDoc('block:w1', 'w1', { ...block('w1') }, 2, false));
            remote.documents.set(snapshotParentPath('no-count'), { createdAt: stamp, label: '无数量', revision: 2 });
            snapshotChild('no-count', 'block:nc', entityDoc('block:nc', 'nc', { ...block('nc') }, 2, false));
            remote.documents.set(snapshotParentPath('legacy-ok'), { createdAt: stamp, label: '旧版一致', entityCount: 1, revision: 2 });
            snapshotChild('legacy-ok', 'block:legacy-ok', entityDoc('block:legacy-ok', 'legacy-ok', { ...block('legacy-ok') }, 2, false));
            remote.documents.set(snapshotParentPath('legacy-short'), { createdAt: stamp, label: '旧版缺项', entityCount: 2, revision: 2 });
            snapshotChild('legacy-short', 'block:legacy-short', entityDoc('block:legacy-short', 'legacy-short', { ...block('legacy-short') }, 2, false));

            const byId = new Map((await service.listCloudRecoverySnapshots(UID)).map((item) => [item.id, item]));
            expect(byId.get('writing-1')!.status).toBe('writing');
            expect(byId.get('no-count')!.status).toBe('unverifiable');
            expect(byId.get('legacy-ok')!.status).toBe('legacy-unverified');
            expect(byId.get('legacy-short')!.status).toBe('legacy-unverified');

            const before = await localBookkeeping(devices[0]);
            await expect(service.restoreCloudRecoverySnapshot(user, 'writing-1')).rejects.toThrow(/尚未完成写入/);
            await expect(service.restoreCloudRecoverySnapshot(user, 'no-count')).rejects.toThrow(/缺少可靠的完整性记录/);
            await expect(service.restoreCloudRecoverySnapshot(user, 'legacy-short')).rejects.toThrow(/不完整/);
            expect(await localBookkeeping(devices[0])).toEqual(before);
            expect(await blockIds(devices[0])).toEqual(['one', 'two']);

            await expect(service.restoreCloudRecoverySnapshot(user, 'legacy-ok')).resolves.toMatchObject({ status: 'legacy-unverified', entityCount: 1 });
            expect(await blockIds(devices[0])).toEqual(['legacy-ok']);
            expect((await devices[0].cloudSyncState.get('state'))!.lastPulledRevision).toBe(2);
        } finally { await close(devices); }
    });

    it('SNAP-03: a document the tolerant merge would silently drop is fatal for a full replacement', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            const service = await import('./cloudSyncService');
            const user = { uid: UID } as any;

            remote.documents.set(snapshotParentPath('damaged'), { createdAt: stamp, label: '损坏', entityCount: 2, revision: 2, complete: true });
            snapshotChild('damaged', 'block:ok', entityDoc('block:ok', 'ok', { ...block('ok') }, 2, false));
            snapshotChild('damaged', 'block:broken', { entityType: 'block', entityId: 'broken', revision: 2, payload: {} });

            const before = await localBookkeeping(devices[0]);
            await expect(service.restoreCloudRecoverySnapshot(user, 'damaged')).rejects.toThrow(/内容哈希/);
            expect(await localBookkeeping(devices[0])).toEqual(before);
            expect(await blockIds(devices[0])).toEqual(['one', 'two']);
        } finally { await close(devices); }
    });

    it('SNAP-04: the cloud-wins replacement still works, and refuses a damaged set before any local write', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            const service = await import('./cloudSyncService');
            const user = { uid: UID } as any;

            // Positive control: the strict validator must not reject a healthy cloud set.
            await expect(service.resolveCloudSyncConflict(user, 'cloud', aggressive)).resolves.toMatchObject({ kind: 'synced', restored: true });

            remote.documents.set(`users/${UID}/syncEntities/block:broken`, {
                entityType: 'block', entityId: 'broken', revision: 3, payload: {},
                contentHash: 'h', contentHashAlgorithm: 'sha256', contentHashVersion: 2, deleted: false,
            });
            remote.documents.set(`users/${UID}/syncState/current`, stateDoc(3, 3));

            const before = await localBookkeeping(devices[0]);
            const localBefore = await blockIds(devices[0]);
            await expect(service.resolveCloudSyncConflict(user, 'cloud', aggressive)).rejects.toThrow(/载荷为空|无法解析|实体/);
            expect(await localBookkeeping(devices[0])).toEqual(before);
            expect(await blockIds(devices[0])).toEqual(localBefore);
        } finally { await close(devices); }
    });

    it('SNAP-05: an unverified commit marker is never advertised, and the retry produces a complete snapshot', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            const service = await import('./cloudSyncService');
            const user = { uid: UID } as any;

            remote.failSnapshotCommitMarker = true;
            await expect(service.resolveCloudSyncConflict(user, 'local', aggressive)).rejects.toThrow('synthetic snapshot commit marker failure');
            expect(allSnapshotParents()).toHaveLength(0);
            expect(allSnapshotChildren().length).toBeGreaterThan(0);
            expect(await service.listCloudRecoverySnapshots(UID)).toEqual([]);

            expect(await service.resolveCloudSyncConflict(user, 'local', aggressive)).toMatchObject({ kind: 'synced' });
            const listed = await service.listCloudRecoverySnapshots(UID);
            expect(listed).toHaveLength(1);
            expect(listed[0].status).toBe('complete');
            expect(listed[0].entityCount).toBe(allSnapshotChildren(listed[0].id).length);
        } finally { await close(devices); }
    });
});

const assetPath = (hash: string) => `users/${UID}/assets/${hash}`;

const assetDocument = (entityId: string, payload: Record<string, unknown>) => ({
    entityType: 'asset', entityId,
    payload: {
        id: entityId, fileName: `${entityId}.png`, title: entityId, kind: 'image',
        createdAt: stamp, updatedAt: stamp,
        ...payload,
    },
    deleted: false, revision: 2, contentHash: `hash-${entityId}`,
    contentHashAlgorithm: 'sha256', contentHashVersion: 2, updatedAt: stamp,
});

describe('P2 downloaded-asset byte verification', () => {
    /**
     * A complete recovery point holding one record and the one asset that address points at.
     * The asset is addressed by `payload.contentHash`, which is the Storage object path suffix.
     */
    async function assetSnapshot(id: string, options: {
        bytes?: string;
        type?: string;
        storedBytes?: string;
        storedType?: string;
        payloadPatch?: Record<string, unknown>;
        entityPatch?: Record<string, unknown>;
    } = {}) {
        const bytes = options.bytes ?? 'asset-bytes';
        const type = options.type ?? 'image/png';
        const blob = new Blob([bytes], { type });
        const hash = await whiteboxHashBlob(blob);
        storageProbe.blobs.set(assetPath(hash), new Blob([options.storedBytes ?? bytes], { type: options.storedType ?? type }));
        remote.documents.set(snapshotParentPath(id), { createdAt: stamp, label: id, entityCount: 2, revision: 2, complete: true });
        snapshotChild(id, `block:${id}`, entityDoc(`block:${id}`, id, { ...block(id), id }, 2, false));
        const photo = `${id}-photo`;
        snapshotChild(id, `asset:${photo}`, {
            ...assetDocument(photo, { mimeType: type, size: blob.size, contentHash: hash, ...(options.payloadPatch ?? {}) }),
            ...(options.entityPatch ?? {}),
        });
        return { hash, blob, photo };
    }

    it('P2-01: verified bytes reach the local database and the cursor only when the whole set is sound', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            const service = await import('./cloudSyncService');
            const user = { uid: UID } as any;
            const { photo } = await assetSnapshot('p2-ok');

            await expect(service.restoreCloudRecoverySnapshot(user, 'p2-ok')).resolves.toMatchObject({
                status: 'complete', entityCount: 2, revision: 2,
            });
            // Exactly one Storage object was fetched, and it had to pass the byte check to get here.
            expect(storageProbe.downloads).toBe(1);
            // fake-indexeddb does not round-trip a Blob, so the persisted row is checked by identity
            // fields; the byte-level proof for this object is the assertion above plus P2-02.
            expect(await devices[0].assets.get(photo)).toMatchObject({
                id: photo, fileName: `${photo}.png`, mimeType: 'image/png', kind: 'image',
            });
            expect(await blockIds(devices[0])).toEqual(['p2-ok']);
            expect((await devices[0].cloudSyncState.get('state'))!.lastPulledRevision).toBe(2);

            // An old asset document declares `fnv1a` for its *entity payload* hash, which says nothing
            // about the blob address. It has to stay restorable.
            await assetSnapshot('p2-legacy', {
                bytes: 'legacy-bytes-ok',
                entityPatch: { contentHashAlgorithm: 'fnv1a', contentHashVersion: 1, contentHash: 'legacy-entity-hash' },
            });
            await expect(service.restoreCloudRecoverySnapshot(user, 'p2-legacy')).resolves.toMatchObject({ entityCount: 2 });
            expect(storageProbe.downloads).toBe(2);
            expect(await blockIds(devices[0])).toEqual(['p2-legacy']);
        } finally { await close(devices); }
    });

    it('P2-02: wrong, truncated or mis-declared bytes are rejected before anything local changes', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            const service = await import('./cloudSyncService');
            const user = { uid: UID } as any;

            // Each snapshot must use its own bytes: the address is derived from the bytes, so two
            // snapshots sharing a content string would share one Storage path and mask each other.
            await assetSnapshot('p2-wrong', { bytes: 'wrong-bytes-01', storedBytes: 'wrong-bytes-99' });
            await assetSnapshot('p2-short', { bytes: 'short-bytes-ok', storedBytes: 'short' });
            await assetSnapshot('p2-size', { bytes: 'size-bytes-ok', payloadPatch: { size: 3 } });
            await assetSnapshot('p2-mime', { bytes: 'mime-bytes-ok', payloadPatch: { mimeType: 'audio/mpeg' } });

            const before = await localBookkeeping(devices[0]);
            const beforeBlocks = await blockIds(devices[0]);

            await expect(service.restoreCloudRecoverySnapshot(user, 'p2-wrong')).rejects.toThrow(/字节内容与声明不一致/);
            await expect(service.restoreCloudRecoverySnapshot(user, 'p2-short')).rejects.toThrow(/字节内容与声明不一致/);
            await expect(service.restoreCloudRecoverySnapshot(user, 'p2-size')).rejects.toThrow(/实际大小 13 字节与声明的 3 字节不一致/);
            await expect(service.restoreCloudRecoverySnapshot(user, 'p2-mime')).rejects.toThrow(/实际类型 image\/png 与声明的 audio\/mpeg 不一致/);

            expect(storageProbe.downloads).toBe(4);
            expect(await localBookkeeping(devices[0])).toEqual(before);
            expect(await blockIds(devices[0])).toEqual(beforeBlocks);
            expect(await devices[0].assets.count()).toBe(0);
        } finally { await close(devices); }
    });

    it('P2-03: an incremental pull that receives damaged bytes lands no update and does not move the cursor', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            const blob = new Blob(['asset-bytes'], { type: 'image/png' });
            const hash = await whiteboxHashBlob(blob);
            storageProbe.blobs.set(assetPath(hash), new Blob(['tampered'], { type: 'image/png' }));
            remote.documents.set(`users/${UID}/syncEntities/asset:a1`, {
                ...assetDocument('a1', { mimeType: 'image/png', size: blob.size, contentHash: hash }), revision: 2,
            });
            remote.documents.set(`users/${UID}/syncEntities/block:extra`, entityDoc('block:extra', 'extra', { ...block('extra') }, 2, false));
            remote.documents.set(`users/${UID}/syncState/current`, stateDoc(2, 2));

            const before = await localBookkeeping(devices[0]);
            const beforeBlocks = await blockIds(devices[0]);
            await expect(sync(devices, 0)).rejects.toThrow(/字节内容与声明不一致/);

            expect(await localBookkeeping(devices[0])).toEqual(before);
            expect(await blockIds(devices[0])).toEqual(beforeBlocks);
            expect(await devices[0].assets.count()).toBe(0);
        } finally { await close(devices); }
    });
});

describe('P2 atomic restore commit', () => {
    it('P2-04: a failure while writing the ledger/cursor rolls the recovery-point replacement back too', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            const service = await import('./cloudSyncService');
            const user = { uid: UID } as any;
            remote.documents.set(snapshotParentPath('p2-atomic'), { createdAt: stamp, label: '原子提交', entityCount: 1, revision: 2, complete: true });
            snapshotChild('p2-atomic', 'block:p2-atomic', entityDoc('block:p2-atomic', 'p2-atomic', { ...block('p2-atomic') }, 2, false));

            const before = await localBookkeeping(devices[0]);
            const beforeBlocks = await blockIds(devices[0]);
            // The data replacement and the ledger/cursor write share one Dexie transaction, so a
            // failure on the bookkeeping half must leave the device on the previous dataset.
            const hook = vi.spyOn(devices[0].cloudSyncLedger, 'bulkPut').mockRejectedValueOnce(new Error('synthetic ledger commit failure'));
            try {
                await expect(service.restoreCloudRecoverySnapshot(user, 'p2-atomic')).rejects.toThrow('synthetic ledger commit failure');
            } finally { hook.mockRestore(); }

            expect(await blockIds(devices[0])).toEqual(beforeBlocks);
            expect(await localBookkeeping(devices[0])).toEqual(before);

            // Retrying with a healthy write completes normally, so the aborted attempt left nothing behind.
            await expect(service.restoreCloudRecoverySnapshot(user, 'p2-atomic')).resolves.toMatchObject({ entityCount: 1 });
            expect(await blockIds(devices[0])).toEqual(['p2-atomic']);
        } finally { await close(devices); }
    });

    it('P2-05: cloud-wins commits its dataset and ledger together, so a rollback restores the old cursor', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            const service = await import('./cloudSyncService');
            const user = { uid: UID } as any;

            const before = await localBookkeeping(devices[0]);
            const beforeBlocks = await blockIds(devices[0]);
            const hook = vi.spyOn(devices[0].cloudSyncLedger, 'bulkPut').mockRejectedValueOnce(new Error('synthetic ledger commit failure'));
            try {
                await expect(service.resolveCloudSyncConflict(user, 'cloud', aggressive)).rejects.toThrow('synthetic ledger commit failure');
            } finally { hook.mockRestore(); }

            expect(await blockIds(devices[0])).toEqual(beforeBlocks);
            expect(await localBookkeeping(devices[0])).toEqual(before);

            await expect(service.resolveCloudSyncConflict(user, 'cloud', aggressive)).resolves.toMatchObject({ kind: 'synced', restored: true });
            expect(await localBookkeeping(devices[0])).not.toEqual(before);
        } finally { await close(devices); }
    });
});

/**
 * F-A — the local-wins rollback archive must never be a truncated archive that claims completeness.
 *
 * `replaceCloudWithLocal` (the user-facing "以本机为准" conflict choice) builds the "冲突前的云端版本"
 * recovery point from a *tolerant* read filtered to `revision <= head`, so the array it archives can
 * silently omit (a) confirmed documents the tolerant parser could not read and (b) unconfirmed
 * documents left above head by an interrupted publish. `makeRemoteSnapshot` stamps that archive
 * `complete: true` with an `entityCount` taken from the same filtered array, and `assertStrictCloudSnapshot`
 * only compares the declaration against the documents just written — a number compared with itself,
 * which structurally cannot fail. The archive is restorable, so a truncated set could replace the
 * local database while advertised as complete.
 *
 * The fix counts the confirmed and pending documents against the server before offering the recovery
 * point. When the count disagrees with what the tolerant read kept (a drop) or any document sits above
 * head (a pending write), it skips the archive and warns instead of fabricating false completeness —
 * while still honoring the local-wins publish, which is the user's explicit choice and the sanctioned
 * way past another device's unconfirmed writes. CONTROL proves a well-formed extra document is still
 * archived, so the skip below is caused by the unprovable set rather than by the fixture.
 */
describe('F-A: the local-wins rollback archive is skipped rather than truncated while claiming completeness', () => {
    const faParentPath = (id: string) => `users/${UID}/syncSnapshots/${id}`;
    const faChildren = (id: string) => [...remote.documents.keys()].filter((path) => path.startsWith(`${faParentPath(id)}/entities/`));
    const faActivePaths = () => [...remote.documents.keys()].filter((path) => path.startsWith(`users/${UID}/syncEntities/`));
    const faRollback = async (service: any) =>
        (await service.listCloudRecoverySnapshots(UID)).find((item: any) => item.label.includes('冲突前的云端版本'));
    const faChildKeys = (id: string) => faChildren(id).map((path) => path.split('/').at(-1));
    /** Resolve a local-wins conflict while capturing every progress message the service surfaces. */
    const faResolveLocal = async (service: any) => {
        const messages: string[] = [];
        const result = await service.resolveCloudSyncConflict({ uid: UID } as any, 'local', { ...aggressive, onProgress: (p: any) => messages.push(p.message) });
        return { result, messages };
    };

    it('CONTROL: a well-formed extra cloud document IS included, so the skip below is caused by an unprovable set', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            const service = await import('./cloudSyncService');
            const baselineCount = faActivePaths().length;
            remote.documents.set(`users/${UID}/syncEntities/block:ghost`,
                entityDoc('block:ghost', 'ghost', { id: 'ghost', type: 'record', title: 'ghost' }, 1));

            const { result } = await faResolveLocal(service);
            expect(result).toMatchObject({ kind: 'synced' });
            const rollback = await faRollback(service);
            expect(rollback).toBeDefined();
            const childKeys = faChildKeys(rollback.id);
            expect(faActivePaths().length).toBe(baselineCount + 1);
            expect(childKeys).toContain('block:ghost');
            expect(remote.documents.get(faParentPath(rollback.id)).entityCount).toBe(childKeys.length);
        } finally { await close(devices); }
    });

    it('F-A-1: a malformed confirmed document makes the set unprovable, so no complete-claiming archive is created', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            const service = await import('./cloudSyncService');
            // Missing `contentHash` => tolerant parseRemoteEntity returns undefined => .filter(Boolean)
            // drops it, so the archived array is one document short of the confirmed cloud set.
            remote.documents.set(`users/${UID}/syncEntities/block:ghost`, {
                key: 'block:ghost', entityType: 'block', entityId: 'ghost',
                payload: { id: 'ghost', type: 'record', title: 'ghost' }, revision: 1, deleted: false,
            });

            const { result, messages } = await faResolveLocal(service);
            // The user's local-wins choice is still honored ...
            expect(result).toMatchObject({ kind: 'synced' });
            // ... but no recovery point is fabricated over the set we could not prove complete.
            expect(await faRollback(service)).toBeUndefined();
            expect(messages.some((message) => message.includes('无法读取的同步数据'))).toBe(true);
        } finally { await close(devices); }
    });

    it('F-A-2: an unconfirmed document above head makes the set unprovable, so no complete-claiming archive is created', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            const service = await import('./cloudSyncService');
            // A publish that committed entity documents but never advanced headRevision leaves them in
            // (headRevision, nextRevision]. synchronizeCloudChanges guards this with
            // hasRemoteRevisionsBetween; replaceCloudWithLocal is the sanctioned override, so it must
            // proceed but cannot capture the pending document in a complete-claiming recovery point.
            remote.documents.set(`users/${UID}/syncEntities/block:pending`,
                entityDoc('block:pending', 'pending', { id: 'pending', type: 'record', title: 'pending' }, 2));

            const { result, messages } = await faResolveLocal(service);
            expect(result).toMatchObject({ kind: 'synced' });
            expect(await faRollback(service)).toBeUndefined();
            expect(messages.some((message) => message.includes('尚未确认的同步写入'))).toBe(true);
        } finally { await close(devices); }
    });
});

/**
 * N1 — incremental cursor poisoning (#4).
 *
 * A normal (non-destructive) pull reads cloud changes with the *tolerant* parser, which silently
 * drops any document it cannot understand. Before the fix, the no-download branch advanced
 * `remoteDatasetCompleteThroughRevision` to head even when every in-range document had been dropped,
 * so the device declared "I hold the complete cloud set through head" over a dataset it had just
 * shrunk — and a later destructive entry trusts that declaration instead of re-validating. The fix
 * freezes the completeness declaration whenever `droppedCount > 0` while still advancing the pull
 * cursor past the unusable document (a malformed doc can never be merged, so staying stuck on it
 * forever would be worse). Only a later full restore, which re-validates strictly, re-establishes it.
 */
describe('N1: a dropped incremental document freezes completeness but still advances the pull cursor (#4)', () => {
    const localSyncState = (device: any) => device.cloudSyncState.get('state');

    it('N1-A: a malformed in-range document advances lastPulledRevision but leaves remoteDatasetCompleteThroughRevision behind', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            // A confirmed cloud document at revision 2 that the tolerant parser cannot read
            // (missing contentHash => parseRemoteEntity returns undefined => dropped).
            remote.documents.set(`users/${UID}/syncEntities/block:bad`, {
                key: 'block:bad', entityType: 'block', entityId: 'bad',
                payload: { id: 'bad', type: 'record', title: 'bad' }, revision: 2, deleted: false,
            });
            remote.documents.set(`users/${UID}/syncState/current`, stateDoc(2));

            const result = await sync(devices, 0);
            expect(result).toMatchObject({ kind: 'synced', downloaded: 0 });

            const state = await localSyncState(devices[0]);
            // The pull cursor moves past the unusable document ...
            expect(state.lastPulledRevision).toBe(2);
            // ... but completeness is frozen at the last revision this device held in full, so it no
            // longer equals the cursor and `complete` cannot be claimed over the shrunk dataset.
            expect(state.remoteDatasetCompleteThroughRevision).toBe(1);
            expect(state.remoteDatasetCompleteThroughRevision).not.toBe(state.lastPulledRevision);
            // The malformed document was never applied locally.
            expect(await devices[0].blocks.get('bad')).toBeUndefined();
        } finally { await close(devices); }
    });

    it('N1-B: when every in-range document parses, both cursors advance together and completeness holds', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            remote.documents.set(`users/${UID}/syncEntities/block:good`, entityDoc('block:good', 'good', block('good'), 2));
            remote.documents.set(`users/${UID}/syncState/current`, stateDoc(2));

            const result = await sync(devices, 0);
            expect(result).toMatchObject({ kind: 'synced', downloaded: 1 });

            const state = await localSyncState(devices[0]);
            expect(state.lastPulledRevision).toBe(2);
            expect(state.remoteDatasetCompleteThroughRevision).toBe(2);
            expect(await devices[0].blocks.get('good')).toBeDefined();
        } finally { await close(devices); }
    });

    it('N1-C: a partial drop applies the parsable document but still freezes completeness (applied branch)', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            // One parsable and one malformed document in (lastPulled, head]: the tolerant reader keeps
            // the first and drops the second, so the applied branch runs with droppedCount === 1.
            remote.documents.set(`users/${UID}/syncEntities/block:good`, entityDoc('block:good', 'good', block('good'), 2));
            remote.documents.set(`users/${UID}/syncEntities/block:bad`, {
                key: 'block:bad', entityType: 'block', entityId: 'bad',
                payload: { id: 'bad', type: 'record', title: 'bad' }, revision: 3, deleted: false,
            });
            remote.documents.set(`users/${UID}/syncState/current`, stateDoc(3));

            const result = await sync(devices, 0);
            expect(result).toMatchObject({ kind: 'synced', downloaded: 1 });

            const state = await localSyncState(devices[0]);
            // The parsable document is applied and the cursor advances to head ...
            expect(await devices[0].blocks.get('good')).toBeDefined();
            expect(state.lastPulledRevision).toBe(3);
            // ... but the drop freezes completeness below the cursor.
            expect(state.remoteDatasetCompleteThroughRevision).toBe(1);
            expect(state.remoteDatasetCompleteThroughRevision).not.toBe(state.lastPulledRevision);
            expect(await devices[0].blocks.get('bad')).toBeUndefined();
        } finally { await close(devices); }
    });
});

/**
 * N2 — Storage GC must never irreversibly delete a blob it cannot prove is unreferenced (#1).
 *
 * `cleanUpUnreferencedStorage` decides what to delete by diffing the Storage listing against the set
 * of asset hashes referenced by cloud entities. Before the fix that referenced set came from
 * `getAllRemote` — a *tolerant* read filtered to `revision <= head` — so it silently omitted (a)
 * documents the tolerant parser dropped as malformed and (b) pending documents an interrupted publish
 * left above head, and it was built against a head that `parseRemoteState` silently defaults to 0 when
 * the field is missing or non-number. Any of those shrinks the referenced set, and every blob it no
 * longer mentions is deleted for good. The delete branch had zero coverage because the storage mock
 * threw on list/deleteObject.
 *
 * The fix adds three unconditional judgments (they must also fire on the manual force-GC entry, which
 * passes allowExpensive): ① skip when the head is untrusted or contradictory; ② skip when the tolerant
 * read comes up short of the raw same-predicate server count; ③ read the whole collection so pending
 * documents protect their blobs too. Each case below asserts both the recorded maintenance outcome and
 * exactly which objects were deleted.
 */
describe('N2: Storage GC refuses to delete blobs it cannot prove are unreferenced (#1)', () => {
    const assetRoot = `users/${UID}/assets`;
    const assetDoc = (hash: string, revision: number) => ({
        key: `asset:${hash}`, entityType: 'asset', entityId: hash,
        payload: { id: hash, contentHash: hash, size: 16, mimeType: 'image/png', fileName: `${hash}.png`, kind: 'image' },
        revision, deleted: false,
        contentHash: `entity-${hash}`, contentHashVersion: 2, contentHashAlgorithm: 'sha256', updatedAt: stamp,
    });
    // Four snapshots so cleanupCloudRecoverySnapshotsIfDue has an expired page (slice(SNAPSHOT_LIMIT))
    // and therefore actually calls cleanUpUnreferencedStorage; the snapshots are childless, so the
    // referenced set is decided entirely by the active entity documents each case stages.
    const seedSnapshots = (count: number) => {
        for (let index = 1; index <= count; index++) {
            remote.documents.set(`users/${UID}/syncSnapshots/snap${index}`, { createdAt: stamp, complete: true, entityCount: 0, status: 'complete' });
        }
    };
    const runGc = async (service: any, device: any) => {
        await service.cleanupCloudRecoverySnapshotsIfDue(UID, { force: true, allowExpensiveStorageGc: true });
        return device.cloudSyncState.get('state');
    };

    it('N2-1: an asset referenced only by a pending document (revision > head) survives; a true orphan is still deleted', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            const service = await import('./cloudSyncService');
            remote.documents.set(`users/${UID}/syncEntities/asset:hashA`, assetDoc('hashA', 1)); // confirmed (<= head 1)
            remote.documents.set(`users/${UID}/syncEntities/asset:hashB`, assetDoc('hashB', 2)); // pending (> head 1)
            storageProbe.objects.set(assetRoot, new Set(['hashA', 'hashB', 'hashOrphan']));
            seedSnapshots(4);

            const state = await runGc(service, devices[0]);
            expect(state.lastSnapshotMaintenanceStatus).toBe('completed');
            // The orphan is reclaimed ...
            expect(storageProbe.deleted).toContain(`${assetRoot}/hashOrphan`);
            // ... but the pending document's blob is protected, and so is the confirmed one.
            expect(storageProbe.deleted).not.toContain(`${assetRoot}/hashB`);
            expect(storageProbe.deleted).not.toContain(`${assetRoot}/hashA`);
        } finally { await close(devices); }
    });

    it('N2-2: a malformed entity document makes the referenced set unprovable, so GC defers and deletes nothing', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            const service = await import('./cloudSyncService');
            // Missing top-level contentHash => parseRemoteEntity returns undefined => the tolerant read
            // drops it, so referenced.length falls one short of the raw server count.
            remote.documents.set(`users/${UID}/syncEntities/asset:hashM`, {
                key: 'asset:hashM', entityType: 'asset', entityId: 'hashM',
                payload: { id: 'hashM', contentHash: 'hashM', size: 16, mimeType: 'image/png', fileName: 'm.png', kind: 'image' },
                revision: 1, deleted: false,
            });
            storageProbe.objects.set(assetRoot, new Set(['hashM', 'hashOrphan']));
            seedSnapshots(4);

            const state = await runGc(service, devices[0]);
            expect(state.lastSnapshotMaintenanceStatus).toBe('deferred-cost');
            expect(state.lastSnapshotMaintenanceError).toContain('无法证明资源引用完整');
            expect(storageProbe.deleted).toEqual([]);
            expect(storageProbe.objects.get(assetRoot)!.has('hashM')).toBe(true);
        } finally { await close(devices); }
    });

    it('N2-3: an untrusted head (non-number headRevision defaulted to 0) defers instead of mass-deleting', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            const service = await import('./cloudSyncService');
            remote.documents.set(`users/${UID}/syncEntities/asset:hashA`, assetDoc('hashA', 1));
            // A corrupt state document: parseRemoteState defaults headRevision to 0 and flags it untrusted.
            remote.documents.set(`users/${UID}/syncState/current`, { protocolVersion: 2, headRevision: 'corrupt', nextRevision: 1, lock: null });
            storageProbe.objects.set(assetRoot, new Set(['hashA', 'hashOrphan']));
            seedSnapshots(4);

            const state = await runGc(service, devices[0]);
            expect(state.lastSnapshotMaintenanceStatus).toBe('deferred-cost');
            expect(state.lastSnapshotMaintenanceError).toContain('云端同步状态不可信');
            // Pre-fix this view (head 0) referenced nothing and deleted every blob.
            expect(storageProbe.deleted).toEqual([]);
        } finally { await close(devices); }
    });

    it('N2-4: a zero head with entities still present is contradictory, so GC defers instead of mass-deleting', async () => {
        const devices = await boot();
        try {
            remote.db = devices[0];
            const service = await import('./cloudSyncService');
            remote.documents.set(`users/${UID}/syncEntities/asset:hashA`, assetDoc('hashA', 1));
            remote.documents.set(`users/${UID}/syncState/current`, stateDoc(0)); // head 0, but entities exist at revision 1
            storageProbe.objects.set(assetRoot, new Set(['hashA', 'hashOrphan']));
            seedSnapshots(4);

            const state = await runGc(service, devices[0]);
            expect(state.lastSnapshotMaintenanceStatus).toBe('deferred-cost');
            expect(state.lastSnapshotMaintenanceError).toContain('云端同步状态不可信');
            expect(storageProbe.deleted).toEqual([]);
        } finally { await close(devices); }
    });
});
