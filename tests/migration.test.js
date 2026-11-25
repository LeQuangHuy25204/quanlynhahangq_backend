'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runMigrations } = require('../sql/run_migration');
const { startServer } = require('../server');

const createMockDb = (initialApplied = []) => {
  const appliedSet = new Set(initialApplied);
  const executedSql = [];
  let closed = false;

  const conn = {
    async query(sql, params = []) {
      if (sql.includes('SELECT `MigrationName` FROM `schema_migrations`')) {
        return [[...appliedSet].map((name) => ({ MigrationName: name }))];
      }
      if (sql.includes('INSERT INTO `schema_migrations`')) {
        appliedSet.add(params[0]);
        return [{ affectedRows: 1 }];
      }
      executedSql.push(sql);
      return [[]];
    },
    async end() {
      closed = true;
    },
  };

  return {
    appliedSet,
    executedSql,
    isClosed: () => closed,
    createConnection: async () => conn,
  };
};

test('runMigrations runs all pending SQL files in order and skips already applied ones', async () => {
  const mockDb = createMockDb();

  const firstRun = await runMigrations({ createConnection: mockDb.createConnection });
  assert.deepEqual(firstRun.applied, [
    '001_vnpay_payment_transaction.sql',
    '002_branch_menu_stock.sql',
    '003_seed_promotions.sql',
  ]);
  assert.deepEqual(firstRun.skipped, []);
  assert.equal(mockDb.isClosed(), true);
  assert.ok(mockDb.executedSql[0].includes('CREATE TABLE IF NOT EXISTS `schema_migrations`'));

  const secondDb = createMockDb(firstRun.applied);
  const secondRun = await runMigrations({ createConnection: secondDb.createConnection });
  assert.deepEqual(secondRun.applied, []);
  assert.deepEqual(secondRun.skipped, [
    '001_vnpay_payment_transaction.sql',
    '002_branch_menu_stock.sql',
    '003_seed_promotions.sql',
  ]);
  assert.equal(secondDb.isClosed(), true);
});

test('runMigrations with force=true re-applies migrations and closes connection on error', async () => {
  const mockDb = createMockDb([
    '001_vnpay_payment_transaction.sql',
    '002_branch_menu_stock.sql',
    '003_seed_promotions.sql',
  ]);

  const forcedRun = await runMigrations({ force: true, createConnection: mockDb.createConnection });
  assert.equal(forcedRun.applied.length, 3);
  assert.deepEqual(forcedRun.skipped, []);
  assert.equal(mockDb.isClosed(), true);

  let closedOnError = false;
  const failingConn = {
    async query(sql) {
      if (sql.includes('CREATE TABLE IF NOT EXISTS `schema_migrations`')) return [[]];
      if (sql.includes('SELECT `MigrationName` FROM `schema_migrations`')) return [[]];
      throw new Error('simulated SQL syntax failure');
    },
    async end() {
      closedOnError = true;
    },
  };

  await assert.rejects(
    () => runMigrations({ createConnection: async () => failingConn }),
    /simulated SQL syntax failure/
  );
  assert.equal(closedOnError, true);
});

test('startServer calls testConnection before runMigrations and then starts HTTP listener', async () => {
  const sequence = [];
  const fakeServer = { fake: true };

  const server = await startServer({
    checkDb: async () => {
      sequence.push('testConnection');
    },
    migrate: async () => {
      sequence.push('runMigrations');
    },
    listenApp: {
      listen(port, cb) {
        sequence.push(`listen:${port}`);
        cb();
        return fakeServer;
      },
    },
    port: 4123,
  });

  assert.equal(server, fakeServer);
  assert.deepEqual(sequence, ['testConnection', 'runMigrations', 'listen:4123']);
});
