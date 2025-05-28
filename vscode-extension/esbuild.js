const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

/**
 * @type {import('esbuild').Plugin}
 */
const copyAssetsPlugin = {
	name: 'copy-assets',
	setup(build) {
		build.onEnd(() => {
			// Copy assets folder to dist
			const assetsSource = path.join(__dirname, 'assets');
			const assetsTarget = path.join(__dirname, 'dist', 'assets');
			
			if (fs.existsSync(assetsSource)) {
				// Create dist/assets directory if it doesn't exist
				if (!fs.existsSync(assetsTarget)) {
					fs.mkdirSync(assetsTarget, { recursive: true });
				}
				
				// Copy all files from assets to dist/assets
				const files = fs.readdirSync(assetsSource);
				files.forEach(file => {
					const sourcePath = path.join(assetsSource, file);
					const targetPath = path.join(assetsTarget, file);
					fs.copyFileSync(sourcePath, targetPath);
				});				
			}
		});
	},
};

async function main() {
	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			copyAssetsPlugin,
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
