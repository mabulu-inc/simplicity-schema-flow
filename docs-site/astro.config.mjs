// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://mabulu-inc.github.io',
	base: '/simplicity-schema',
	integrations: [
		starlight({
			title: 'simplicity-schema',
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/mabulu-inc/simplicity-schema',
				},
			],
			sidebar: [
				{
					label: 'Getting started',
					items: [
						{ label: 'Introduction', slug: 'getting-started/introduction' },
						{ label: 'Quick start', slug: 'getting-started/quick-start' },
						{ label: 'Configuration', slug: 'getting-started/configuration' },
					],
				},
				{
					label: 'Schema YAML',
					items: [
						{ label: 'Tables', slug: 'schema/tables' },
						{ label: 'Enums', slug: 'schema/enums' },
						{ label: 'Functions', slug: 'schema/functions' },
						{ label: 'Views', slug: 'schema/views' },
						{ label: 'Roles', slug: 'schema/roles' },
						{ label: 'Extensions', slug: 'schema/extensions' },
						{ label: 'Mixins', slug: 'schema/mixins' },
						{ label: 'Pre/post scripts', slug: 'schema/scripts' },
					],
				},
				{
					label: 'CLI',
					items: [
						{ label: 'Commands', slug: 'cli/commands' },
						{ label: 'Global flags', slug: 'cli/flags' },
					],
				},
				{
					label: 'Safety & operations',
					items: [
						{ label: 'Destructive protection', slug: 'safety/destructive-protection' },
						{ label: 'Zero-downtime patterns', slug: 'safety/zero-downtime' },
						{ label: 'Expand/contract migrations', slug: 'safety/expand-contract' },
						{ label: 'Rollback', slug: 'safety/rollback' },
						{ label: 'Lint rules', slug: 'safety/lint' },
					],
				},
				{
					label: 'TypeScript API',
					items: [
						{ label: 'Overview', slug: 'api/overview' },
						{ label: 'Pipeline', slug: 'api/pipeline' },
						{ label: 'Introspection', slug: 'api/introspection' },
						{ label: 'Drift & lint', slug: 'api/drift-lint' },
						{ label: 'Rollback & expand', slug: 'api/rollback-expand' },
						{ label: 'Generation', slug: 'api/generation' },
						{ label: 'Database utilities', slug: 'api/database' },
						{ label: 'Testing helpers', slug: 'api/testing' },
						{ label: 'Types', slug: 'api/types' },
					],
				},
				{
					label: 'Architecture',
					items: [
						{ label: 'Pipeline stages', slug: 'architecture/pipeline' },
						{ label: 'Execution phases', slug: 'architecture/execution-phases' },
						{ label: 'Internal schema', slug: 'architecture/internal-schema' },
						{ label: 'Source layout', slug: 'architecture/source-layout' },
					],
				},
			],
		}),
	],
});
