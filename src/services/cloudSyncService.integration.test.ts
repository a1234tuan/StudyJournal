import { describe, expect, it, vi } from "vitest";
vi.mock("./firebase", () => ({ firebaseAuth: { currentUser: null }, firebaseStorage: {}, firestore: {}, googleAuthProvider: {} }));
const auditRemote = vi.hoisted(() => ({ documents: new Map<string, any>(), reads: 0, queries: 0, writes: 0, db: undefined as any, onQuery: undefined as undefined | (() => Promise<void>), failPublishHead: false, failMetadataBatch: 0, metadataBatches: 0 }));
vi.mock('../db/database', async (importOriginal) => {
    const actual = await importOriginal<any>();
    const fake = await import('fake-indexeddb');
    const dexie = (await import('dexie')).default;
    dexie.dependencies.indexedDB = fake.indexedDB;
    dexie.dependencies.IDBKeyRange = fake.IDBKeyRange;
    return { ...actual, get db() { return auditRemote.db; } };
});
vi.mock('firebase/firestore', async (importOriginal) => {
    const actual = await importOriginal<any>();
    const snap = (path: string) => ({ id: path.split('/').at(-1), exists: () => auditRemote.documents.has(path), data: () => structuredClone(auditRemote.documents.get(path)) });
    const getDocs = async (target: any) => {
        auditRemote.queries++;
        const hook = auditRemote.onQuery;
        auditRemote.onQuery = undefined;
        await hook?.();
        let rows = [...auditRemote.documents].filter(([path]) => path.startsWith(target.path + '/') && !path.slice(target.path.length + 1).includes('/'));
        for (const constraint of target.constraints ?? []) {
            if (constraint.kind !== 'where')
                continue;
            rows = rows.filter(([path, value]) => { const field = constraint.field === '__name__' ? path.split('/').at(-1) : value[constraint.field]; return constraint.op === 'in' ? constraint.value.includes(field) : constraint.op === '>' ? field > constraint.value : constraint.op === '<' ? field < constraint.value : constraint.op === '<=' ? field <= constraint.value : field === constraint.value; });
        }
        const cap = target.constraints?.find((constraint: any) => constraint.kind === 'limit');
        if (cap) rows = rows.slice(0, cap.count);
        auditRemote.reads += rows.length;
        return { docs: rows.map(([path]) => snap(path)), size: rows.length, empty: rows.length === 0 };
    };
    return { ...actual, doc: (_db: any, ...parts: string[]) => ({ path: parts.join('/') }), collection: (_db: any, ...parts: string[]) => ({ path: parts.join('/') }), documentId: () => '__name__', where: (field: string, op: string, value: any) => ({ kind: 'where', field, op, value }), limit: (count: number) => ({ kind: 'limit', count }), orderBy: () => ({ kind: 'order' }), query: (target: any, ...constraints: any[]) => ({ ...target, constraints }), getDoc: async (target: any) => { auditRemote.reads++; return snap(target.path); }, getDocs, getCountFromServer: async (target: any) => ({ data: () => ({ count: [...auditRemote.documents.keys()].filter(path => path.startsWith(target.path + '/')).length }) }), runTransaction: async (_db: any, callback: any) => {
            const pending: any[] = [];
            const result = await callback({ get: async (target: any) => { auditRemote.reads++; return snap(target.path); }, set: (target: any, value: any) => pending.push([target.path, structuredClone(value)]) });
            if (pending.some(([path]) => path.includes('/syncEntities/') || path.includes('/reviewEvents/'))) {
                auditRemote.metadataBatches++;
                if (auditRemote.metadataBatches === auditRemote.failMetadataBatch) throw new Error('synthetic metadata batch failure');
            }
            for (const [path, value] of pending) {
                if (auditRemote.failPublishHead && path.endsWith("/syncState/current") && value.headRevision === 2 && value.lock === null) {
                    auditRemote.failPublishHead = false;
                    throw new Error("synthetic head commit failure");
                }
                auditRemote.documents.set(path, value);
                auditRemote.writes++;
            }
            return result;
        } };
});
import { StudyJournalDatabase as AuditDatabase } from '../db/database';
import { storage as auditStorage } from './storageAdapter';
import { exportCloudSync as auditExport } from './cloudSyncModel';
import { DEFAULT_SETTINGS as auditDefaultSettings } from '../db/defaults';
const auditStamp = '2026-09-21T00:00:00.000Z';
const auditSubject = auditDefaultSettings.subjects?.[0]?.name ?? '数学';
const auditRecord = (id: string) => ({ id, type: 'record', date: '2026-09-21', order: 0, subject: auditSubject, title: 'base ' + id, contentHtml: '<p></p>', assets: [], formulas: [], mistakeRefs: [], tags: [], createdAt: auditStamp, updatedAt: auditStamp, favorite: false });
async function auditSeed() {
    auditRemote.documents.clear();
    auditRemote.reads = 0;
    auditRemote.queries = 0;
    auditRemote.writes = 0;
    auditRemote.failMetadataBatch = 0;
    auditRemote.metadataBatches = 0;
    const devices = [new AuditDatabase('audit-sync-phone-' + crypto.randomUUID()), new AuditDatabase('audit-sync-desktop-' + crypto.randomUUID())];
    for (const database of devices) {
        await database.open();
        await database.blocks.bulkPut([auditRecord('one'), auditRecord('two')] as any);
        await database.settings.put(structuredClone(auditDefaultSettings));
    }
    auditRemote.db = devices[0];
    const baseline = await auditExport(await auditStorage.createCloudSyncSnapshot());
    for (const database of devices) {
        await database.cloudSyncState.put({ id: 'state', deviceId: database.name, userId: 'audit-user', lastPulledRevision: 1, lastReviewEventRevision: 1, remoteDatasetCompleteThroughRevision: 1 });
        await database.cloudSyncLedger.bulkPut(baseline.entities.map(entity => ({ id: entity.key, entityType: entity.entityType, entityId: entity.entityId, contentHash: entity.contentHash, contentHashVersion: entity.contentHashVersion, contentHashAlgorithm: entity.contentHashAlgorithm, cloudRevision: 1, basePayload: entity.entityType === 'settings' ? entity.payload : undefined })));
    }
    auditRemote.documents.set('users/audit-user/syncState/current', { protocolVersion: 2, headRevision: 1, nextRevision: 1, lock: null });
    for (const entity of baseline.entities)
        auditRemote.documents.set('users/audit-user/syncEntities/' + entity.key, { ...entity, revision: 1 });
    return devices;
}
async function auditClose(devices: any[]) { const Dexie = (await import('dexie')).default; for (const database of devices) {
    database.close();
    await Dexie.delete(database.name);
} }
describe('full service controlled remote', () => {
    it.each([0, 1])('converges simple unilateral edit direction %s using independent DBs and ledgers', async (sender) => {
        const devices = await auditSeed();
        try {
            const service = await import('./cloudSyncService');
            const user = { uid: 'audit-user' } as any;
            auditRemote.db = devices[sender];
            await auditStorage.saveBlock({ ...auditRecord('one'), title: 'sender edit' } as any);
            const first = await service.synchronizeCloudChanges(user);
            auditRemote.db = devices[1 - sender];
            const pull = await service.synchronizeCloudChanges(user);
            expect((await devices[1 - sender].blocks.get('one') as any).title).toBe('sender edit');
            const before = { reads: auditRemote.reads, writes: auditRemote.writes, queries: auditRemote.queries };
            const second = await service.synchronizeCloudChanges(user);
            auditRemote.db = devices[sender];
            const third = await service.synchronizeCloudChanges(user);
            expect(second).toMatchObject({ kind: 'synced', uploaded: 0, downloaded: 0 });
            expect(third).toMatchObject({ kind: 'synced', uploaded: 0, downloaded: 0 });
            expect(auditRemote.writes).toBe(before.writes);
            expect(auditRemote.queries).toBe(before.queries);
        }
        finally {
            await auditClose(devices);
        }
    });
    it('pulls unrelated later revisions when reconciling a successful unknown upload', async () => {
        const devices = await auditSeed();
        try {
            const service = await import('./cloudSyncService');
            auditRemote.db = devices[0];
            await auditStorage.saveBlock({ ...auditRecord('one'), title: 'A uploaded revision 2' } as any);
            const changed = (await auditExport(await auditStorage.createCloudSyncSnapshot())).entities.find(entity => entity.key === 'block:one')!;
            auditRemote.documents.set('users/audit-user/syncEntities/block:one', { ...changed, revision: 2 });
            auditRemote.db = devices[1];
            await auditStorage.saveBlock({ ...auditRecord('two'), title: 'B later revision 3' } as any);
            const later = (await auditExport(await auditStorage.createCloudSyncSnapshot())).entities.find(entity => entity.key === 'block:two')!;
            auditRemote.documents.set('users/audit-user/syncEntities/block:two', { ...later, revision: 3 });
            auditRemote.documents.set('users/audit-user/syncState/current', { protocolVersion: 2, headRevision: 3, nextRevision: 3, lock: null });
            auditRemote.db = devices[0];
            const operation = { id: 'audit-unknown', operationId: 'audit-unknown', userId: 'audit-user', deviceId: devices[0].name, revision: 2, previousHeadRevision: 1, expectedEntities: [{ key: changed.key, contentHash: changed.contentHash }], expectedEvents: [], phase: 'releasing', status: 'unknown', lockReleaseError: 'synthetic lost release response', lockReleaseAttempts: 1, createdAt: auditStamp, updatedAt: auditStamp };
            await devices[0].cloudSyncOperations.put(operation as any);
            const result = await service.synchronizeCloudChanges({ uid: 'audit-user' } as any);
            const state = await devices[0].cloudSyncState.get('state');
            expect(state!.lastPulledRevision).toBe(3);
            expect(await devices[0].cloudSyncOperations.get('audit-unknown')).toMatchObject({ status: 'succeeded', lockReleaseError: undefined, lockReleaseAttempts: undefined });
            expect((await devices[0].blocks.get('two') as any).title).toBe('B later revision 3');
            expect(result).toMatchObject({ kind: 'synced', uploaded: 0 });
            const repeat = await service.synchronizeCloudChanges({ uid: 'audit-user' } as any);
            expect(repeat).toMatchObject({ kind: 'synced', uploaded: 0, downloaded: 0 });
        }
        finally {
            await auditClose(devices);
        }
    });
    it.each(['one', 'two'])('refuses to overwrite hidden metadata before owner recovery when editing %s', async (editedId) => {
        const devices = await auditSeed();
        try {
            const service = await import('./cloudSyncService');
            const user = { uid: 'audit-user' } as any;
            auditRemote.db = devices[0];
            await auditStorage.saveBlock({ ...auditRecord('one'), title: 'committed but hidden' } as any);
            const hidden = (await auditExport(await auditStorage.createCloudSyncSnapshot())).entities.find(entity => entity.key === 'block:one')!;
            auditRemote.documents.set('users/audit-user/syncEntities/block:one', { ...hidden, revision: 2 });
            auditRemote.documents.set('users/audit-user/syncState/current', { protocolVersion: 2, headRevision: 1, nextRevision: 2, lock: null });
            await devices[0].cloudSyncOperations.put({ id: 'hidden-operation', operationId: 'hidden-operation', userId: user.uid, deviceId: devices[0].name, revision: 2, previousHeadRevision: 1, expectedEntities: [{ key: hidden.key, contentHash: hidden.contentHash }], expectedEvents: [], phase: 'releasing', status: 'unknown', createdAt: auditStamp, updatedAt: auditStamp });
            auditRemote.db = devices[1];
            await auditStorage.saveBlock({ ...auditRecord(editedId), title: 'B independent edit' } as any);
            await expect(service.synchronizeCloudChanges(user)).rejects.toThrow('尚未确认的同步写入');
            expect(auditRemote.documents.get('users/audit-user/syncEntities/block:one').contentHash).toBe(hidden.contentHash);
            expect((await devices[1].cloudSyncState.get('state'))!.lastPulledRevision).toBe(1);
            auditRemote.db = devices[0];
            expect(await service.synchronizeCloudChanges(user)).toMatchObject({ kind: 'synced', uploaded: 0 });
            auditRemote.db = devices[1];
            const result = await service.synchronizeCloudChanges(user);
            if (editedId === 'one') {
                expect(result).toMatchObject({ kind: 'conflict', conflict: { reason: 'concurrent-changes' } });
            } else {
                expect(result).toMatchObject({ kind: 'synced', uploaded: 1 });
                expect((await devices[1].blocks.get('one') as any).title).toBe('committed but hidden');
                expect(await service.synchronizeCloudChanges(user)).toMatchObject({ kind: 'synced', uploaded: 0, downloaded: 0 });
            }
        } finally {
            await auditClose(devices);
        }
    });
});
describe('mutation fences and controls', () => {
    it('advances a verified empty remote delta without repeated queries or writes', async () => {
        const devices = await auditSeed();
        try {
            const service = await import('./cloudSyncService');
            auditRemote.documents.set('users/audit-user/syncState/current', { protocolVersion: 2, headRevision: 2, nextRevision: 2, lock: null });
            await service.synchronizeCloudChanges({ uid: 'audit-user' } as any);
            expect((await devices[0].cloudSyncState.get('state'))!.lastPulledRevision).toBe(2);
            const before = { queries: auditRemote.queries, writes: auditRemote.writes };
            expect(await service.synchronizeCloudChanges({ uid: 'audit-user' } as any)).toMatchObject({ kind: 'synced', uploaded: 0, downloaded: 0 });
            expect(auditRemote.queries).toBe(before.queries);
            expect(auditRemote.writes).toBe(before.writes);
        } finally { await auditClose(devices); }
    });
    it('reconciles the committed part of a failed multi-batch publish and uploads only the remainder', async () => {
        const devices = await auditSeed();
        try {
            const service = await import('./cloudSyncService');
            const user = { uid: 'audit-user' } as any;
            auditRemote.db = devices[0];
            await devices[0].blocks.bulkPut(Array.from({ length: 401 }, (_, index) => auditRecord('bulk-' + index)) as any);
            auditRemote.failMetadataBatch = 2;
            expect(await service.synchronizeCloudChanges(user)).toMatchObject({ kind: 'uncertain' });
            expect([...auditRemote.documents.values()].filter(row => row.revision === 2)).toHaveLength(400);
            const retried = await service.synchronizeCloudChanges(user);
            expect(retried).toMatchObject({ kind: 'synced', uploaded: 1 });
            auditRemote.db = devices[1];
            expect(await service.synchronizeCloudChanges(user)).toMatchObject({ kind: 'synced', uploaded: 0, downloaded: 401 });
            expect(await devices[1].blocks.count()).toBe(403);
            const beforeWrites = auditRemote.writes;
            expect(await service.synchronizeCloudChanges(user)).toMatchObject({ kind: 'synced', uploaded: 0, downloaded: 0 });
            auditRemote.db = devices[0];
            expect(await service.synchronizeCloudChanges(user)).toMatchObject({ kind: 'synced', uploaded: 0, downloaded: 0 });
            expect(auditRemote.writes).toBe(beforeWrites);
        } finally {
            await auditClose(devices);
        }
    });
    it.each([0, 1])('preserves genuine same-record conflicts in direction %s', async (sender) => {
        const devices = await auditSeed();
        try {
            const service = await import('./cloudSyncService');
            auditRemote.db = devices[sender];
            await auditStorage.saveBlock({ ...auditRecord('one'), title: 'A independently edited' } as any);
            await service.synchronizeCloudChanges({ uid: 'audit-user' } as any);
            auditRemote.db = devices[1 - sender];
            await auditStorage.saveBlock({ ...auditRecord('one'), title: 'B independently edited' } as any);
            const result = await service.synchronizeCloudChanges({ uid: 'audit-user' } as any);
            expect(result).toMatchObject({ kind: 'conflict', conflict: { reason: 'concurrent-changes', conflicts: [{ key: 'block:one' }] } });
            expect((await devices[1 - sender].blocks.get('one') as any).title).toBe('B independently edited');
        }
        finally {
            await auditClose(devices);
        }
    });
    it('commits the plan row and mutation epoch as one local write operation', async () => {
        const devices = await auditSeed();
        try {
            const service = await import('./cloudSyncService');
            const user = { uid: 'audit-user' } as any;
            auditRemote.db = devices[0];
            await auditStorage.saveBlock({ ...auditRecord('one'), title: 'remote edit' } as any);
            await service.synchronizeCloudChanges(user);
            auditRemote.db = devices[1];
            const beforeEpoch = await auditStorage.getCloudSyncMutationEpoch();
            await auditStorage.saveDailyPlan({ id: 'late-plan', date: '2026-09-21', subject: auditDefaultSettings.subjects?.[0]?.name ?? '数学', title: 'do not lose', order: 0, createdAt: auditStamp, updatedAt: auditStamp } as any);
            expect(await devices[1].dailyPlans.get('late-plan')).toMatchObject({ title: 'do not lose' });
            expect(await auditStorage.getCloudSyncMutationEpoch()).toBe(beforeEpoch + 1);
            const result = await service.synchronizeCloudChanges(user);
            expect(result.kind).toBe('synced');
            expect(auditRemote.documents.has('users/audit-user/syncEntities/daily-plan:late-plan')).toBe(true);
        }
        finally {
            auditRemote.onQuery = undefined;
            vi.restoreAllMocks();
            await auditClose(devices);
        }
    });
    it('does not interrupt a pull for a no-op plan reclaim', async () => {
        const devices = await auditSeed();
        try {
            const service = await import('./cloudSyncService');
            const user = { uid: 'audit-user' } as any;
            for (const database of devices) {
                await database.blocks.put({ ...auditRecord('one'), contentHtml: '<p>saved learning content</p>' } as any);
                await database.dailyPlans.put({ id: 'plan-kept', date: '2026-09-21', subject: auditDefaultSettings.subjects?.[0]?.name ?? '数学', title: 'plan', linkedRecordId: 'one', order: 0, createdAt: auditStamp, updatedAt: auditStamp });
            }
            auditRemote.db = devices[0];
            const baseline = await auditExport(await auditStorage.createCloudSyncSnapshot());
            for (const database of devices) {
                await database.cloudSyncLedger.bulkPut(baseline.entities.map(entity => ({ id: entity.key, entityType: entity.entityType, entityId: entity.entityId, contentHash: entity.contentHash, contentHashVersion: entity.contentHashVersion, contentHashAlgorithm: entity.contentHashAlgorithm, cloudRevision: 1 })));
            }
            for (const entity of baseline.entities)
                auditRemote.documents.set('users/audit-user/syncEntities/' + entity.key, { ...entity, revision: 1 });
            await auditStorage.saveBlock({ ...auditRecord('two'), title: 'remote edit' } as any);
            await service.synchronizeCloudChanges(user);
            auditRemote.db = devices[1];
            const before = await auditExport(await auditStorage.createCloudSyncSnapshot());
            const beforeEpoch = await auditStorage.getCloudSyncMutationEpoch();
            auditRemote.onQuery = async () => { expect(await auditStorage.reclaimEmptyPlanRecords()).toEqual([]); };
            const result = await service.synchronizeCloudChanges(user);
            const after = await auditExport(await auditStorage.createCloudSyncSnapshot());
            expect(after.entities.find(row => row.key === 'daily-plan:plan-kept')?.contentHash).toBe(before.entities.find(row => row.key === 'daily-plan:plan-kept')?.contentHash);
            expect(result).toMatchObject({ kind: 'synced', uploaded: 0, downloaded: 1 });
            expect((await devices[1].blocks.get('two') as any).title).toBe('remote edit');
            expect(await auditStorage.getCloudSyncMutationEpoch()).toBe(beforeEpoch + 1);
        }
        finally {
            auditRemote.onQuery = undefined;
            await auditClose(devices);
        }
    });
});
describe('delete and restore lifecycle', () => {
    it.each([0, 1])('propagates deleted empty plan and log without resurrection in direction %s', async (sender) => {
        const devices = await auditSeed();
        try {
            const service = await import('./cloudSyncService');
            const user = { uid: 'audit-user' } as any;
            auditRemote.db = devices[sender];
            await auditStorage.saveBlock({ ...auditRecord('empty-log'), planId: 'empty-plan' } as any);
            await auditStorage.saveDailyPlan({ id: 'empty-plan', date: '2026-09-21', subject: auditSubject, title: 'empty plan', order: 0, linkedRecordId: 'empty-log', createdAt: auditStamp, updatedAt: auditStamp } as any);
            await service.synchronizeCloudChanges(user);
            auditRemote.db = devices[1 - sender];
            await service.synchronizeCloudChanges(user);
            auditRemote.db = devices[sender];
            await auditStorage.deleteDailyPlan('empty-plan');
            expect(await auditStorage.reclaimEmptyPlanRecords()).toContain('empty-log');
            const published = await service.synchronizeCloudChanges(user);
            auditRemote.db = devices[1 - sender];
            const pulled = await service.synchronizeCloudChanges(user);
            const repeated = await service.synchronizeCloudChanges(user);
            expect(repeated).toMatchObject({ kind: 'synced', uploaded: 0, downloaded: 0 });
        }
        finally {
            await auditClose(devices);
        }
    });
    it('keeps restored-away voice sessions cleared when an old runtime pauses', async () => {
        const devices = await auditSeed();
        let runtime: any;
        try {
            const { VoiceRecallRuntimeController } = await import('../features/voiceRecall/runtimeController');
            const { VoiceRecallRepository } = await import('../features/voiceRecall/repository');
            auditRemote.db = devices[0];
            const snapshot = await auditStorage.createCloudSyncSnapshot();
            runtime = new VoiceRecallRuntimeController(new VoiceRecallRepository(devices[0]));
            const id = await runtime.createSession({ mode: 'scope-practice', source: { kind: 'review-card', recordIds: ['one'] }, inputMode: 'auto-half-duplex' });
            runtime.dispatch({ type: 'OPEN_PREFLIGHT' });
            runtime.dispatch({ type: 'CONFIRM_DISCLOSURE', confirmed: true });
            runtime.dispatch({ type: 'CONNECT' });
            runtime.dispatch({ type: 'CONNECTED' });
            await auditStorage.restoreSnapshot(snapshot);
            expect(await devices[0].voiceRecallSessions.get(id)).toBeUndefined();
            const epoch = await auditStorage.getCloudSyncMutationEpoch();
            await runtime.pause();
            expect(await devices[0].voiceRecallSessions.get(id)).toBeUndefined();
            expect(await auditStorage.getCloudSyncMutationEpoch()).toBe(epoch);
            const exported = await auditExport(await auditStorage.createCloudSyncSnapshot());
            expect(JSON.stringify(exported.entities)).not.toContain(id);
        }
        finally {
            await runtime?.end();
            await auditClose(devices);
        }
    });
    it('recovers metadata visibility before another device publishes after a head failure', async () => {
        const devices = await auditSeed();
        try {
            const service = await import('./cloudSyncService');
            const user = { uid: 'audit-user' } as any;
            auditRemote.db = devices[0];
            await auditStorage.saveBlock({ ...auditRecord('one'), title: 'A metadata committed' } as any);
            auditRemote.failPublishHead = true;
            expect(await service.synchronizeCloudChanges(user)).toMatchObject({ kind: 'uncertain' });
            expect(auditRemote.documents.get('users/audit-user/syncState/current').headRevision).toBe(2);
            expect(auditRemote.documents.get('users/audit-user/syncEntities/block:one').revision).toBe(2);
            auditRemote.db = devices[1];
            await auditStorage.saveBlock({ ...auditRecord('two'), title: 'B unrelated change' } as any);
            const published = await service.synchronizeCloudChanges(user);
            const repeated = await service.synchronizeCloudChanges(user);
            expect((await devices[1].blocks.get('one') as any).title).toBe('A metadata committed');
            expect(repeated).toMatchObject({ kind: 'synced', uploaded: 0, downloaded: 0 });
        }
        finally {
            auditRemote.failPublishHead = false;
            await auditClose(devices);
        }
    });
});
describe('soft-delete retention', () => {
    it.each([0, 1])('preserves the sender recycle-bin record after a passive return sync direction %s', async (sender) => {
        const devices = await auditSeed();
        try {
            const service = await import('./cloudSyncService');
            const user = { uid: 'audit-user' } as any;
            auditRemote.db = devices[sender];
            await auditStorage.deleteBlock('one');
            expect((await auditStorage.listDeletedBlocks()).map(row => row.id)).toContain('one');
            await service.synchronizeCloudChanges(user);
            auditRemote.db = devices[1 - sender];
            const pull = await service.synchronizeCloudChanges(user);
            expect(pull).toMatchObject({ kind: 'synced', uploaded: 0, downloaded: 1 });
            auditRemote.db = devices[sender];
            const returnSync = await service.synchronizeCloudChanges(user);
            expect((await auditStorage.listDeletedBlocks()).map(row => row.id)).toContain('one');
            expect(await auditStorage.restoreBlock('one')).toMatchObject({ id: 'one', title: 'base one' });
            expect(returnSync).toMatchObject({ kind: 'synced', uploaded: 0, downloaded: 0 });
        }
        finally {
            await auditClose(devices);
        }
    });
});
describe('startup read-only receiver', () => {
    it.each([0, 1])('remains converged after database reopen and real initialization direction %s', async (sender) => {
        const devices = await auditSeed();
        try {
            const service = await import('./cloudSyncService');
            const user = { uid: 'audit-user' } as any;
            auditRemote.db = devices[sender];
            await auditStorage.initialize();
            await service.synchronizeCloudChanges(user);
            auditRemote.db = devices[1 - sender];
            await service.synchronizeCloudChanges(user);
            auditRemote.db = devices[sender];
            await auditStorage.saveBlock({ ...auditRecord('two'), title: 'changed before restart' } as any);
            await service.synchronizeCloudChanges(user);
            auditRemote.db = devices[1 - sender];
            devices[1 - sender].close();
            await devices[1 - sender].open();
            await auditStorage.initialize();
            const received = await service.synchronizeCloudChanges(user);
            expect((await devices[1 - sender].blocks.get('two') as any).title).toBe('changed before restart');
            devices[1 - sender].close();
            await devices[1 - sender].open();
            await auditStorage.initialize();
            const repeated = await service.synchronizeCloudChanges(user);
            auditRemote.db = devices[sender];
            const returned = await service.synchronizeCloudChanges(user);
            expect(repeated).toMatchObject({ kind: 'synced', uploaded: 0, downloaded: 0 });
            expect(returned).toMatchObject({ kind: 'synced', uploaded: 0, downloaded: 0 });
        }
        finally {
            await auditClose(devices);
        }
    });
});
