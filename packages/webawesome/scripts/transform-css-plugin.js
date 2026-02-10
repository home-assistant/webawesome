import esbuild from 'esbuild';
import { readFile } from 'fs/promises';

/**
 * esbuild plugin that transforms CSS inside Lit css template literals in .styles.ts files
 *
 * This plugin intercepts .styles.ts files and transforms modern CSS features
 * (like :has(), color-mix(), CSS nesting) to be compatible with older browsers.
 *
 * @returns {import('esbuild').Plugin}
 */
export function transformCssPlugin() {
  return {
    name: 'transform-css-in-styles',
    setup(build) {
      build.onLoad({ filter: /\.styles\.ts$/ }, async args => {
        let fileContent = await readFile(args.path, 'utf8');

        // match css`...` template literals
        const cssTemplateRegex = /css`((?:[^`\\]|\\.|`(?!`))*)`/gs;

        const matches = [...fileContent.matchAll(cssTemplateRegex)];

        for (const match of matches) {
          const css = match[1];

          try {
            const result = await esbuild.transform(css, {
              loader: 'css',
              target: 'safari15',
            });

            const transformedTemplate = `css\`${result.code}\``;
            fileContent = fileContent.replace(match[0], transformedTemplate);
          } catch (error) {
            console.warn(`Warning: Failed to transform CSS in ${args.path}:`, error.message);
          }
        }

        return {
          contents: fileContent,
          loader: 'ts',
        };
      });
    },
  };
}
