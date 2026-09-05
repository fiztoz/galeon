// Isolate module mocks so React and Tauri stubs cannot leak between hook suites.
const tests = new Bun.Glob('*.test.ts');
for await (const file of tests.scan(import.meta.dir)) {
  const process = Bun.spawn(['bun', 'test', `${import.meta.dir}/${file}`], { stdout: 'inherit', stderr: 'inherit' });
  const code = await process.exited;
  if (code !== 0) globalThis.process.exit(code);
}
