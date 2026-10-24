/**
 * B2 数据迁移：把 traits 中的旧前缀数据迁入结构化字段
 *
 * 背景（见 Docs/Stage_Opt_AR_Blueprint.md B2）：
 * 历史上角色的外观 / 规范名 / 所属同人以字符串前缀的形式混存在
 * Character.traits 数组里：
 *   traits = ["勇敢", "appearance:brown hair, red armor", "canonical:Kane", "fandom:某作品"]
 * 读取依赖 startsWith / slice 字符串匹配，脆弱且污染性格特征展示。
 *
 * 现已落地结构化列：Character.appearance / Character.canonicalName。
 * 本脚本负责存量数据的一次性迁移，扫描两个数据源：
 *   1. PostgreSQL characters 表（主数据源）
 *   2. data/characters.json（遗留 JSON 文件存储）
 *
 * 对每条命中旧前缀的记录：
 *   - "appearance:xxx" → 写入 appearance 列（仅当列为空；已有值则保留）
 *   - "canonical:xxx"  → 写入 canonicalName 列（仅当列为空；已有值则保留）
 *   - "fandom:xxx"     → 从 traits 中剔除；若所属故事的
 *                        DirectorState.worldVariables.fandom_name 为空则回填
 *   - 全部前缀条目从 traits 中剔除，traits 只保留性格特征
 *
 * 特性：
 *   - 幂等：可重复执行，第二次运行命中数为 0
 *   - --dry-run：只打印将要发生的变更，不写库/不写文件
 *   - --db-only / --json-only：限定只跑某个数据源
 *
 * 用法：
 *   npx tsx scripts/migrate-character-appearance.ts              # DB + JSON
 *   npx tsx scripts/migrate-character-appearance.ts --dry-run    # 预览
 *   npx tsx scripts/migrate-character-appearance.ts --json-only  # 只迁移 JSON
 *
 * 注意：若 DB 尚未执行过 `npm run db:push`（appearance/canonicalName 列），
 * 请先推送 schema 再运行本脚本。
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { splitLegacyTraitFields, type SplitLegacyTraitFieldsResult } from '../src/lib/character-fields';

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run') || args.has('-n');
const DB_ONLY = args.has('--db-only');
const JSON_ONLY = args.has('--json-only');

const MAX_DETAIL_LINES = 15;

function describeHit(name: string, r: SplitLegacyTraitFieldsResult): string {
  const parts: string[] = [];
  if (r.legacyAppearance) parts.push(`appearance(${r.legacyAppearance.length}字)`);
  if (r.legacyCanonicalName) parts.push(`canonicalName="${r.legacyCanonicalName}"`);
  if (r.legacyFandom) parts.push(`fandom="${r.legacyFandom}"(剔除)`);
  return `  - ${name}: ${parts.join('，')}；traits 清洗为 [${r.cleanTraits.join('、')}]`;
}

// ── DB 迁移 ──────────────────────────────────────────────────────────

async function migrateDb() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const characters = await prisma.character.findMany({
      select: {
        id: true,
        name: true,
        storyId: true,
        traits: true,
        appearance: true,
        canonicalName: true,
      },
    });

    console.log(`[db] 扫描 characters 表：共 ${characters.length} 个角色`);

    let hit = 0;
    let detailLines = 0;
    // storyId -> fandom（"fandom:" 前缀值），待回填 DirectorState
    const fandomByStory = new Map<string, string>();

    for (const c of characters) {
      const result = splitLegacyTraitFields(c.traits);
      if (!result.hadLegacyEntries) continue;
      hit++;

      const structuredAppearance = typeof c.appearance === 'string' ? c.appearance.trim() : '';
      const structuredCanonical = typeof c.canonicalName === 'string' ? c.canonicalName.trim() : '';
      const nextAppearance = structuredAppearance ? c.appearance : (result.legacyAppearance || '');
      const nextCanonical = structuredCanonical ? c.canonicalName : (result.legacyCanonicalName || '');

      if (detailLines < MAX_DETAIL_LINES) {
        console.log(describeHit(c.name, result));
        detailLines++;
      } else if (detailLines === MAX_DETAIL_LINES) {
        console.log('  ...（更多明细省略）');
        detailLines++;
      }

      if (!DRY_RUN) {
        await prisma.character
          .update({
            where: { id: c.id },
            data: {
              traits: result.cleanTraits as any[],
              appearance: nextAppearance,
              canonicalName: nextCanonical,
            },
          })
          .catch((e: Error) => console.warn(`  [warn] 更新角色 ${c.name}(${c.id}) 失败: ${e.message}`));
      }

      if (result.legacyFandom && c.storyId && !fandomByStory.has(c.storyId)) {
        fandomByStory.set(c.storyId, result.legacyFandom);
      }
    }

    console.log(`[db] 命中旧前缀：${hit} 个角色${DRY_RUN ? '（dry-run，未写入）' : '，已迁移'}`);

    // fandom 回填：仅当故事 DirectorState.worldVariables.fandom_name 为空
    let backfilled = 0;
    for (const [storyId, fandom] of fandomByStory) {
      try {
        const state = await prisma.directorState.findUnique({ where: { storyId } });
        const wv = (state?.worldVariables as Record<string, unknown>) || {};
        if (wv.fandom_name) continue;

        if (!DRY_RUN) {
          await prisma.directorState.update({
            where: { storyId },
            data: { worldVariables: { ...wv, fandom_name: fandom } as any },
          });
        }
        backfilled++;
        console.log(`[db] 回填 DirectorState.worldVariables.fandom_name="${fandom}"（story ${storyId}）${DRY_RUN ? '（dry-run）' : ''}`);
      } catch (e) {
        console.warn(`  [warn] 回填 story ${storyId} 的 fandom_name 失败:`, (e as Error).message);
      }
    }

    return { scanned: characters.length, hit, backfilled };
  } finally {
    await prisma.$disconnect().catch(() => {});
    await pool.end().catch(() => {});
  }
}

// ── JSON 迁移 ────────────────────────────────────────────────────────

function migrateJson() {
  const filepath = path.join(process.cwd(), 'data', 'characters.json');
  if (!fs.existsSync(filepath)) {
    console.log('[json] 未找到 data/characters.json，跳过');
    return { scanned: 0, hit: 0 };
  }

  let characters: any[];
  try {
    characters = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } catch (e) {
    console.warn(`[json] 解析 data/characters.json 失败: ${(e as Error).message}`);
    return { scanned: 0, hit: 0 };
  }
  if (!Array.isArray(characters)) {
    console.warn('[json] data/characters.json 不是数组，跳过');
    return { scanned: 0, hit: 0 };
  }

  console.log(`[json] 扫描 data/characters.json：共 ${characters.length} 个角色`);

  let hit = 0;
  let changed = 0;
  for (const c of characters) {
    let dirty = false;

    const result = splitLegacyTraitFields(c.traits);
    if (result.hadLegacyEntries) {
      hit++;
      c.traits = result.cleanTraits;
      if (!(typeof c.appearance === 'string' && c.appearance.trim()) && result.legacyAppearance) {
        c.appearance = result.legacyAppearance;
      }
      if (!(typeof c.canonicalName === 'string' && c.canonicalName.trim()) && result.legacyCanonicalName) {
        c.canonicalName = result.legacyCanonicalName;
      }
      dirty = true;
      console.log(describeHit(c.name, result));
    }

    // 与 DB schema 对齐：补齐结构化字段默认值（幂等，首次运行后不再变化）
    if (typeof c.appearance !== 'string') {
      c.appearance = '';
      dirty = true;
    }
    if (typeof c.canonicalName !== 'string') {
      c.canonicalName = '';
      dirty = true;
    }

    if (dirty) changed++;
  }

  if (changed > 0 && !DRY_RUN) {
    fs.writeFileSync(filepath, JSON.stringify(characters, null, 2) + '\n');
  }

  console.log(`[json] 命中旧前缀：${hit} 个角色；共更新 ${changed} 条记录${DRY_RUN ? '（dry-run，未写入）' : ''}`);
  return { scanned: characters.length, hit };
}

// ── main ────────────────────────────────────────────────────────────

async function main() {
  console.log('========================================');
  console.log('B2 角色结构化字段迁移（appearance / canonicalName）');
  console.log(`模式：${DB_ONLY ? '仅 DB' : JSON_ONLY ? '仅 JSON' : 'DB + JSON'}${DRY_RUN ? '（dry-run 预览）' : ''}`);
  console.log('========================================');

  const results: Array<{ source: string; scanned: number; hit: number }> = [];

  if (!JSON_ONLY) {
    const r = await migrateDb();
    results.push({ source: 'db', scanned: r.scanned, hit: r.hit });
  }
  if (!DB_ONLY) {
    const r = migrateJson();
    results.push({ source: 'json', scanned: r.scanned, hit: r.hit });
  }

  console.log('----------------------------------------');
  for (const r of results) {
    console.log(`  ${r.source}: 扫描 ${r.scanned}，命中 ${r.hit}`);
  }
  const totalHit = results.reduce((n, r) => n + r.hit, 0);
  console.log(
    totalHit === 0
      ? '✅ 没有需要迁移的旧前缀数据（已是最新格式）'
      : `✅ 迁移完成${DRY_RUN ? '（dry-run，未实际写入；去掉 --dry-run 后正式执行）' : ''}`,
  );
}

main()
  .catch((e) => {
    console.error('迁移脚本执行失败:', e);
    process.exit(1);
  });
