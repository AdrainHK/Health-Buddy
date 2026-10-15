// 把技能定义（skill.md）复制到 dist，运行时和源码同目录读取
import { cpSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.md')) cpSync(path, path.replace(/^src/, 'dist'));
  }
}
walk('src');
