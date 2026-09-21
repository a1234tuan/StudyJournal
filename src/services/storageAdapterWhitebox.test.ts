import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./firebase", () => ({ firebaseAuth: { currentUser: null }, firebaseStorage: {}, firestore: {}, googleAuthProvider: {} }));
const holder = vi.hoisted(() => ({ db: undefined as any }));
vi.mock('../db/database', async (importOriginal) => {
    const actual = await importOriginal<any>();
    const fake = await import('fake-indexeddb');
    const dexie = (await import('dexie')).default;
    dexie.dependencies.indexedDB = fake.indexedDB;
    dexie.dependencies.IDBKeyRange = fake.IDBKeyRange;
    return { ...actual, get db() { return holder.db; } };
});
import { StudyJournalDatabase } from '../db/database';
import { storage } from './storageAdapter';
import { hasPlanRecordContent } from '../lib/dailyPlan';
import { DexieReviewCoachRepository } from '../features/reviewCoach/repository';
import { ReviewCoachValidationError } from '../features/reviewCoach/validation';
import { DEFAULT_SETTINGS } from '../db/defaults';
import { completeCoachTestSnapshot, coachTestBlock } from '../features/reviewCoach/reviewCoachTestFixtures';
import { restoreReviewCoachFormalSnapshot, reviewCoachRestoreTables } from '../features/reviewCoach/repository';

const stamp = '2026-09-21T00:00:00.000Z';
const subject = DEFAULT_SETTINGS.subjects?.[0]?.name ?? '数学';
const record = (id: string, extra: Record<string, unknown> = {}) => ({
    id, type: 'record', date: '2026-09-21', order: 0, subject, title: 'base ' + id,
    contentHtml: '<p></p>', assets: [], formulas: [], mistakeRefs: [], tags: [],
    createdAt: stamp, updatedAt: stamp, favorite: false, ...extra,
});
const plan = (id: string, extra: Record<string, unknown> = {}) => ({
    id, date: '2026-09-21', subject, title: 'plan ' + id, order: 0, createdAt: stamp, updatedAt: stamp, ...extra,
});

const databases: any[] = [];
async function boot(seed: { blocks?: any[]; plans?: any[] } = {}) {
    const database = new StudyJournalDatabase('wb-store-' + crypto.randomUUID());
    databases.push(database);
    await database.open();
    await database.blocks.put(record('one') as any);
    await database.settings.put(structuredClone(DEFAULT_SETTINGS));
    if (seed.blocks) await database.blocks.bulkPut(seed.blocks as any);
    if (seed.plans) await database.dailyPlans.bulkPut(seed.plans as any);
    holder.db = database;
    return database;
}

afterEach(async () => {
    vi.restoreAllMocks();
    const Dexie = (await import('dexie')).default;
    while (databases.length) {
        const database = databases.pop();
        database.close();
        await Dexie.delete(database.name);
    }
});

describe('W-13 mutation epoch shares the business transaction', () => {
    it('rolls the epoch back when a plan write fails', async () => {
        const database = await boot();
        const before = await storage.getCloudSyncMutationEpoch();
        vi.spyOn(database.dailyPlans, 'put').mockRejectedValueOnce(new Error('synthetic write failure'));
        await expect(storage.saveDailyPlan(plan('p') as any)).rejects.toThrow();
        expect(await storage.getCloudSyncMutationEpoch()).toBe(before);
        expect(await database.dailyPlans.get('p')).toBeUndefined();
    });

    it('bumps the epoch exactly once per real plan change', async () => {
        const database = await boot();
        const before = await storage.getCloudSyncMutationEpoch();
        await storage.saveDailyPlan(plan('p') as any);
        expect(await storage.getCloudSyncMutationEpoch()).toBe(before + 1);
        expect(await database.dailyPlans.get('p')).toMatchObject({ title: 'plan p' });
    });

    it('rolls the epoch back when a record write fails', async () => {
        const database = await boot();
        const before = await storage.getCloudSyncMutationEpoch();
        vi.spyOn(database.blocks, 'put').mockRejectedValueOnce(new Error('synthetic write failure'));
        await expect(storage.saveBlock(record('one', { title: 'edited' }) as any)).rejects.toThrow();
        expect(await storage.getCloudSyncMutationEpoch()).toBe(before);
        expect(await database.blocks.get('one')).toMatchObject({ title: 'base one' });
    });
});

describe('W-14 no-op paths must not bump the epoch', () => {
    it('ignores identical plan saves, repeated deletes and identical links', async () => {
        const database = await boot({ plans: [plan('p', { linkedRecordId: 'one' })] });
        const before = await storage.getCloudSyncMutationEpoch();
        await storage.saveDailyPlan(plan('p', { linkedRecordId: 'one' }) as any);
        await storage.linkPlanRecord('p', 'one');
        await storage.deleteDailyPlan('p');
        await storage.deleteDailyPlan('p');
        const afterFirstDelete = await storage.getCloudSyncMutationEpoch();
        await storage.deleteDailyPlan('p');
        await storage.linkPlanRecord('p', 'other');
        expect(await storage.getCloudSyncMutationEpoch()).toBe(afterFirstDelete);
        expect(afterFirstDelete).toBe(before + 1);
        expect(await database.dailyPlans.get('p')).toMatchObject({ linkedRecordId: 'one' });
    });

    it('ignores a reclaim pass with nothing to reclaim', async () => {
        await boot({ blocks: [record('has-content', { contentHtml: '<p>real work</p>' })], plans: [plan('p', { linkedRecordId: 'has-content' })] });
        const before = await storage.getCloudSyncMutationEpoch();
        expect(await storage.reclaimEmptyPlanRecords()).toEqual([]);
        expect(await storage.getCloudSyncMutationEpoch()).toBe(before);
    });

    it('bumps once and clears the link when something is actually reclaimed', async () => {
        const database = await boot({ plans: [plan('p', { linkedRecordId: 'shell' })] });
        await database.blocks.put(record('shell') as any);
        const before = await storage.getCloudSyncMutationEpoch();
        expect(await storage.reclaimEmptyPlanRecords()).toContain('shell');
        expect(await storage.getCloudSyncMutationEpoch()).toBe(before + 1);
        expect(await database.dailyPlans.get('p')).toMatchObject({ linkedRecordId: undefined });
    });
});

describe('W-15 saving a stale plan copy must not resurrect it', () => {
    it('keeps a soft-deleted plan deleted', async () => {
        const database = await boot({ plans: [plan('p')] });
        const live = structuredClone(await database.dailyPlans.get('p'));
        await storage.deleteDailyPlan('p');
        const deletedAt = (await database.dailyPlans.get('p'))!.deletedAt;
        expect(deletedAt).toBeDefined();

        const before = await storage.getCloudSyncMutationEpoch();
        await expect(storage.saveDailyPlan(live as any)).rejects.toThrow('计划已删除');
        expect(await storage.getCloudSyncMutationEpoch()).toBe(before);

        expect((await database.dailyPlans.get('p'))!.deletedAt).toBe(deletedAt);
        expect((await storage.listDailyPlans()).map((item) => item.id)).not.toContain('p');
    });
});

describe('W-16 reclaim must not resurrect a plan deleted mid-pass', () => {
    it('keeps the plan deleted when the delete lands between the scan and the transaction', async () => {
        const database = await boot({ blocks: [record('shell')], plans: [plan('p', { linkedRecordId: 'shell' })] });
        const original = database.transaction.bind(database);
        let injected = false;
        vi.spyOn(database, 'transaction').mockImplementation(((async (...args: any[]) => {
            if (!injected) {
                injected = true;
                const fresh = await database.dailyPlans.get('p');
                if (fresh && !fresh.deletedAt) await database.dailyPlans.put({ ...fresh, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
            }
            return (original as any)(...args);
        }) as any));

        const reclaimed = await storage.reclaimEmptyPlanRecords();

        expect(injected).toBe(true);
        expect(reclaimed).toContain('shell');
        expect((await database.dailyPlans.get('p'))!.deletedAt).toBeDefined();
    });
});

describe('W-17 expectedRecord guards', () => {
    it('preserves a replacement link and new title committed before reclaim starts', async () => {
        const database = await boot({ blocks: [record('shell'), record('replacement', { contentHtml: '<p>real content</p>' })], plans: [plan('p', { linkedRecordId: 'shell' })] });
        const original = database.transaction.bind(database);
        let injected = false;
        vi.spyOn(database, 'transaction').mockImplementation((async (...args: any[]) => {
            if (!injected) {
                injected = true;
                await storage.saveDailyPlan({ ...(await database.dailyPlans.get('p'))!, title: 'new title' });
                await storage.linkPlanRecord('p', 'replacement');
            }
            return (original as any)(...args);
        }) as any);
        expect(await storage.reclaimEmptyPlanRecords()).toEqual([]);
        expect(injected).toBe(true);
        expect(await database.dailyPlans.get('p')).toMatchObject({ title: 'new title', linkedRecordId: 'replacement' });
        expect(await database.blocks.get('shell')).toBeDefined();
        expect(await database.blocks.get('replacement')).toBeDefined();
    });

    it('rolls back record purge, plan link and mutation together if reclaim writeback fails', async () => {
        const database = await boot({ blocks: [record('shell')], plans: [plan('p', { linkedRecordId: 'shell' })] });
        const before = await storage.getCloudSyncMutationEpoch();
        vi.spyOn(database.dailyPlans, 'put').mockRejectedValueOnce(new Error('synthetic write failure'));
        await expect(storage.reclaimEmptyPlanRecords()).rejects.toThrow('synthetic write failure');
        expect(await database.blocks.get('shell')).toBeDefined();
        expect(await database.dailyPlans.get('p')).toMatchObject({ linkedRecordId: 'shell' });
        expect(await storage.getCloudSyncMutationEpoch()).toBe(before);
    });
    it('accepts a save whose baseline still matches the stored row', async () => {
        const database = await boot();
        const row = await database.blocks.get('one');
        await expect(storage.saveBlock({ ...row, title: 'edited' } as any, { expectedRecord: row as any })).resolves.toMatchObject({ title: 'edited' });
        const again = await database.blocks.get('one');
        await expect(storage.saveBlock({ ...again } as any, { expectedRecord: again as any })).resolves.toBeDefined();
    });

    it('rejects both branches with the same actionable message', async () => {
        const database = await boot();
        const stale = await database.blocks.get('one');
        await database.blocks.put({ ...stale, title: 'changed elsewhere' } as any);

        let plain: unknown;
        try { await storage.saveBlock({ ...stale, title: 'local edit' } as any, { expectedRecord: stale as any }); } catch (error) { plain = error; }
        expect(plain).toBeDefined();

        let coach: unknown;
        try {
            await new DexieReviewCoachRepository(database).saveRecordWithDecisionBlocks(
                { ...stale, title: 'local edit' } as any,
                { contentHtml: (stale as any).contentHtml, blocks: [], removals: [] } as any,
                true,
                stale as any,
            );
        } catch (error) { coach = error; }
        expect(coach).toBeDefined();

        expect((coach as Error).name).toBe((plain as Error).name);
        expect((coach as Error).message).toBe((plain as Error).message);
        expect((plain as Error).message).toContain('正式内容已更新');
    });
});


describe('W-25 public recovery boundaries', () => {
    it('rejects invalid backup and cloud snapshots before replacing existing data', async () => {
        const database = await boot({ blocks: [record(coachTestBlock.recordId)] });
        const snapshot = await storage.createSnapshot();
        snapshot.payload.reviewCoach = completeCoachTestSnapshot();
        snapshot.payload.reviewCoach.delayedVerifications[0].taskId = 'missing-task';
        const before = await storage.getCloudSyncMutationEpoch();
        for (const restore of [storage.restoreSnapshot.bind(storage), storage.restoreCloudSyncSnapshot.bind(storage)]) {
            await expect(restore(snapshot)).rejects.toMatchObject({ code: 'invalid-verification-task' });
            expect(await database.blocks.get('one')).toBeDefined();
            expect(await database.delayedVerifications.count()).toBe(0);
            expect(await storage.getCloudSyncMutationEpoch()).toBe(before);
        }
    });

    it('restores valid evidence over a corrupt local link and purges related facts together', async () => {
        const database = await boot({ blocks: [record(coachTestBlock.recordId)] });
        await database.transaction('rw', reviewCoachRestoreTables(database), () => restoreReviewCoachFormalSnapshot(database, completeCoachTestSnapshot()));
        const valid = await storage.createSnapshot();
        const verification = (await database.delayedVerifications.toArray())[0];
        await database.delayedVerifications.put({ ...verification, taskId: 'missing-task' });
        await storage.restoreSnapshot(valid);
        expect((await database.delayedVerifications.get(verification.id))!.taskId).toBe(verification.taskId);
        await storage.permanentlyDeleteBlock(coachTestBlock.recordId);
        expect(await database.delayedVerifications.count()).toBe(0);
        expect(await database.adaptiveReviewTasks.count()).toBe(0);
    });
});

describe('W-18 updatedAt-only remote touch', () => {
    it('pins the current strictness for a content-identical baseline', async () => {
        const database = await boot();
        const stale = await database.blocks.get('one');
        await database.blocks.put({ ...stale, updatedAt: '2026-09-22T00:00:00.000Z' } as any);
        await expect(storage.saveBlock({ ...stale, title: 'local edit' } as any, { expectedRecord: stale as any }))
            .rejects.toThrow('正式内容已更新');
    });
});

describe('W-19 emptiness verdict boundary', () => {
    it('classifies content-bearing shapes correctly', () => {
        expect(hasPlanRecordContent(record('a', { contentHtml: '' }) as any, { assets: [] })).toBe(false);
        expect(hasPlanRecordContent(record('b', { contentHtml: '<p>  </p>' }) as any, { assets: [] })).toBe(false);
        expect(hasPlanRecordContent(record('c', { assets: [{ id: 'a1', title: '图', kind: 'image' }] }) as any, { assets: [] })).toBe(true);
        expect(hasPlanRecordContent(record('d', { formulas: [{ id: 'f1', latex: 'x^2' }] }) as any, { assets: [] })).toBe(true);
        expect(hasPlanRecordContent(record('e', { tags: ['tag'] }) as any, { assets: [] })).toBe(true);
        expect(hasPlanRecordContent(record('f', { contentHtml: '<p>text</p>' }) as any, { assets: [] })).toBe(true);
    });

    it('does not reclaim a record whose only content is an asset', async () => {
        const database = await boot({ blocks: [record('image-only', { assets: [{ id: 'a1', title: '图', kind: 'image' }] })], plans: [plan('p', { linkedRecordId: 'image-only' })] });
        expect(await storage.reclaimEmptyPlanRecords()).toEqual([]);
        expect(await database.blocks.get('image-only')).toBeDefined();
    });
});
