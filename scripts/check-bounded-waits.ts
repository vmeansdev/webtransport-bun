#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import ts from "typescript";

const ROOT = resolve(
	process.env.CHECK_BOUNDED_WAITS_ROOT ?? resolve(import.meta.dir, ".."),
);
const TARGETS = (
	process.env.CHECK_BOUNDED_WAITS_TARGETS?.split(":").filter(Boolean) ?? [
		"packages/webtransport/test",
		"tools/interop/tests",
		"tools/interop/tests-wasm",
		"tools/interop/addon-server.ts",
		"tools/interop/browser-helpers.ts",
		"tools/interop/run-iwa.mjs",
		"examples/webtransport-wasm-iwa/app.js",
	]
).map((target) => resolve(ROOT, target));
const CANONICAL_HELPERS = new Map<string, Set<string>>([
	[
		"packages/webtransport/test/helpers/harness.ts",
		new Set(["readWithTimeout", "nextWithTimeout"]),
	],
	[
		"tools/interop/browser-helpers.ts",
		new Set(["readWithTimeout", "nextWithTimeout"]),
	],
]);

type WaitHit = {
	file: string;
	line: number;
	column: number;
	kind: "alias" | "bind" | "for-await" | "method";
	functionName: string | null;
	methodName?: "next" | "read";
};

type WaitAlias = {
	methodName: "next" | "read";
};

type Scope = Map<string, WaitAlias>;

function inferFunctionName(node: ts.SignatureDeclarationBase): string | null {
	if ("name" in node && node.name && ts.isIdentifier(node.name)) {
		return node.name.text;
	}

	const parent = node.parent;
	if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
		return parent.name.text;
	}
	if (ts.isPropertyAssignment(parent)) {
		if (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name)) {
			return parent.name.text;
		}
	}
	if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
		return node.name.text;
	}

	return null;
}

function enclosingFunctionName(node: ts.Node): string | null {
	let current: ts.Node | undefined = node.parent;
	while (current) {
		if (ts.isFunctionLike(current)) {
			return inferFunctionName(current);
		}
		current = current.parent;
	}
	return null;
}

function isCanonicalHelper(
	filePath: string,
	functionName: string | null,
): boolean {
	if (!functionName) {
		return false;
	}
	const relativePath = normalizeRelativePath(filePath);
	const allowedFunctions = CANONICAL_HELPERS.get(relativePath);
	return allowedFunctions?.has(functionName) ?? false;
}

function normalizeRelativePath(filePath: string): string {
	return relative(ROOT, filePath).split(sep).join("/");
}

function listTargetFiles(targetPath: string): string[] {
	if (!existsSync(targetPath)) {
		return [];
	}
	try {
		const entries = readdirSync(targetPath, { withFileTypes: true });
		const files: string[] = [];
		for (const entry of entries) {
			const fullPath = resolve(targetPath, entry.name);
			if (entry.isDirectory()) {
				files.push(...listTargetFiles(fullPath));
				continue;
			}
			if (
				entry.isFile() &&
				(entry.name.endsWith(".ts") ||
					entry.name.endsWith(".js") ||
					entry.name.endsWith(".mjs"))
			) {
				files.push(fullPath);
			}
		}
		return files;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOTDIR") {
			return targetPath.endsWith(".ts") ||
				targetPath.endsWith(".js") ||
				targetPath.endsWith(".mjs")
				? [targetPath]
				: [];
		}
		throw error;
	}
}

function scriptKindFor(filePath: string): ts.ScriptKind {
	if (filePath.endsWith(".js")) {
		return ts.ScriptKind.JS;
	}
	if (filePath.endsWith(".mjs")) {
		return ts.ScriptKind.JS;
	}
	return ts.ScriptKind.TS;
}

function resolveRawMethodAlias(
	node: ts.Expression | undefined,
	scopeStack: Scope[],
): WaitAlias | null {
	if (!node) {
		return null;
	}
	if (ts.isIdentifier(node)) {
		for (let index = scopeStack.length - 1; index >= 0; index -= 1) {
			const alias = scopeStack[index]?.get(node.text);
			if (alias) {
				return alias;
			}
		}
		return null;
	}
	if (
		ts.isPropertyAccessExpression(node) &&
		(node.name.text === "read" || node.name.text === "next")
	) {
		return { methodName: node.name.text };
	}
	if (
		ts.isCallExpression(node) &&
		ts.isPropertyAccessExpression(node.expression) &&
		node.expression.name.text === "bind"
	) {
		return resolveRawMethodAlias(node.expression.expression, scopeStack);
	}
	return null;
}

function registerBindingName(
	name: ts.BindingName,
	methodName: "next" | "read",
	scopeStack: Scope[],
): void {
	const scope = scopeStack.at(-1);
	if (!scope) {
		return;
	}
	if (ts.isIdentifier(name)) {
		scope.set(name.text, { methodName });
		return;
	}
	if (!ts.isObjectBindingPattern(name)) {
		return;
	}
	for (const element of name.elements) {
		if (!ts.isIdentifier(element.name)) {
			continue;
		}
		const propertyName =
			element.propertyName && ts.isIdentifier(element.propertyName)
				? element.propertyName.text
				: element.name.text;
		if (propertyName === methodName) {
			scope.set(element.name.text, { methodName });
		}
	}
}

function maybeRegisterAlias(
	node: ts.VariableDeclaration | ts.BinaryExpression,
	scopeStack: Scope[],
): void {
	if (ts.isVariableDeclaration(node)) {
		if (ts.isObjectBindingPattern(node.name)) {
			for (const methodName of ["read", "next"] as const) {
				registerBindingName(node.name, methodName, scopeStack);
			}
		}
		const alias = resolveRawMethodAlias(node.initializer, scopeStack);
		if (!alias) {
			return;
		}
		registerBindingName(node.name, alias.methodName, scopeStack);
		return;
	}

	if (
		node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
		ts.isIdentifier(node.left)
	) {
		const alias = resolveRawMethodAlias(node.right, scopeStack);
		if (alias) {
			scopeStack.at(-1)?.set(node.left.text, alias);
		}
	}
}

function findRawWaits(filePath: string): WaitHit[] {
	const sourceText = readFileSync(filePath, "utf8");
	const sourceFile = ts.createSourceFile(
		filePath,
		sourceText,
		ts.ScriptTarget.Latest,
		true,
		scriptKindFor(filePath),
	);
	const hits: WaitHit[] = [];
	const scopeStack: Scope[] = [new Map()];

	function pushScope(): void {
		scopeStack.push(new Map());
	}

	function popScope(): void {
		scopeStack.pop();
	}

	function recordHit(
		node: ts.Node,
		kind: WaitHit["kind"],
		methodName?: "next" | "read",
	): void {
		const functionName = enclosingFunctionName(node);
		if (isCanonicalHelper(filePath, functionName)) {
			return;
		}
		const { line, character } = sourceFile.getLineAndCharacterOfPosition(
			node.getStart(),
		);
		hits.push({
			file: normalizeRelativePath(filePath),
			line: line + 1,
			column: character + 1,
			kind,
			functionName,
			methodName,
		});
	}

	function visit(node: ts.Node): void {
		const createsScope =
			ts.isBlock(node) ||
			ts.isCaseBlock(node) ||
			ts.isCatchClause(node) ||
			ts.isFunctionLike(node);
		if (createsScope) {
			pushScope();
		}

		if (ts.isVariableDeclaration(node)) {
			maybeRegisterAlias(node, scopeStack);
		}
		if (ts.isBinaryExpression(node)) {
			maybeRegisterAlias(node, scopeStack);
		}

		if (ts.isCallExpression(node)) {
			const directMethod = resolveRawMethodAlias(node.expression, scopeStack);
			if (directMethod) {
				recordHit(
					node,
					ts.isIdentifier(node.expression) ? "alias" : "method",
					directMethod.methodName,
				);
			} else if (
				ts.isPropertyAccessExpression(node.expression) &&
				node.expression.name.text === "bind"
			) {
				const boundMethod = resolveRawMethodAlias(
					node.expression.expression,
					scopeStack,
				);
				if (boundMethod) {
					recordHit(node, "bind", boundMethod.methodName);
				}
			}
		}
		if (ts.isForOfStatement(node) && node.awaitModifier) {
			recordHit(node, "for-await");
		}

		ts.forEachChild(node, visit);

		if (createsScope) {
			popScope();
		}
	}

	visit(sourceFile);
	return hits;
}

const files = TARGETS.flatMap(listTargetFiles).sort((a, b) =>
	a.localeCompare(b),
);
const violations: WaitHit[] = [];

for (const file of files) {
	const hits = findRawWaits(file);
	violations.push(...hits);
}

if (violations.length > 0) {
	console.error("Unbounded awaited iterator/read operations found:");
	for (const violation of violations) {
		if (violation.kind === "for-await") {
			console.error(
				`- ${violation.file}:${violation.line}:${violation.column} for await loop without deadline guard` +
					(violation.functionName ? ` (in ${violation.functionName})` : ""),
			);
			continue;
		}
		if (violation.kind === "bind") {
			console.error(
				`- ${violation.file}:${violation.line}:${violation.column} ${violation.methodName}.bind() ` +
					`outside canonical bounded helper${violation.functionName ? ` (in ${violation.functionName})` : ""}`,
			);
			continue;
		}
		if (violation.kind === "alias") {
			console.error(
				`- ${violation.file}:${violation.line}:${violation.column} alias for ${violation.methodName}() ` +
					`outside canonical bounded helper${violation.functionName ? ` (in ${violation.functionName})` : ""}`,
			);
			continue;
		}
		console.error(
			`- ${violation.file}:${violation.line}:${violation.column} ${violation.methodName}() ` +
				`outside canonical bounded helper${violation.functionName ? ` (in ${violation.functionName})` : ""}`,
		);
	}
	process.exit(1);
}

console.log(
	`Bounded wait scan passed across ${files.length} test files with ${CANONICAL_HELPERS.size} canonical helper files.`,
);
