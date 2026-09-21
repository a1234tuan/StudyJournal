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
}));
const storageProbe = vi.hoisted(() => ({ metadataCalls: 0 }));
vi.mock('firebase/storage', () => ({
    ref: (_storage: unknown, path: string) => ({ fullPath: path }),
    getMetadata: async () => { storageProbe.metadataCalls++; throw new Error('synthetic 检查云端资源超时'); },
    uploadBytesResumable: () => { throw new Error('unexpected upload'); },
    getBlob: () => { throw new Error('unexpected download'); },
    list: () => { throw new Error('unexpected list'); },
    deleteObject: () => { throw new Error('unexpected delete'); },
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
    const snap = (path: string) => ({ id: path.split('/').at(-1), exists: () => remote.documents.has(path), data: () => structuredClone(remote.documents.get(path)) });
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
        doc: (_db: any, ...parts: string[]) => ({ path: parts.join('/') }),
        collection: (_db: any, ...parts: string[]) => ({ path: parts.join('/') }),
        documentId: () => '__name__',
        where: (field: string, op: string, value: any) => ({ kind: 'where', field, op, value }),
        limit: (count: number) => ({ kind: 'limit', count }),
        orderBy: () => ({ kind: 'order' }),
        query: (target: any, ...constraints: any[]) => ({ ...target, constraints }),
        getDoc: async (target: any) => { remote.reads++; return snap(target.path); },
        getDocs,
        getCountFromServer: async (target: any) => ({ data: () => ({ count: [...remote.documents.keys()].filter(path => path.startsWith(target.path + '/')).length }) }),
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
import { exportCloudSync as whiteboxExport } from './cloudSyncModel';
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
