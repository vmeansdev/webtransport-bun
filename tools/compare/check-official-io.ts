/**
 * Audit-only RED checker for the official comparison child graph.
 *
 * This file is deliberately not imported by comparison production code.  It
 * reads the source tree and the frozen JSON contract, resolves the graph with
 * the installed TypeScript compiler, and reports a bounded deterministic
 * inventory.  It has no source-write, process-spawn, network, or addon-loading
 * path; stdout is used only for its required CLI report.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

export const OFFICIAL_IO_ALLOWLIST_SCHEMA =
	"comparison-official-io-allowlist/v1" as const;
// Large enough that the bounded inventory is COMPLETE for any plausible
// tree: a silently truncated inventory reads as "everything else is clean"
// and poisons the frozen RED failure oracle (Task A step 12).
export const MAX_FAILURES = 4096;

const TOOLS_COMPARE_ROOT = "tools/compare";
const CHECKER_FILE = "check-official-io.ts";
const ALLOWLIST_FILE = "official-io-allowlist.json";
const OFFICIAL_ROOTS = [
	"artifact-builder.ts",
	"render-report.ts",
	"run-campaign.ts",
	"verify-artifact.ts",
] as const;

const ALLOWLIST_KEYS = [
	"officialRoots",
	"roleChildTs",
	"protocolOnlyTs",
	"controllerOnlyTs",
	"fixtureTs",
	"checkerTs",
	"cliEntryTs",
	"nativeSources",
	"resolvedStaticImports",
	"packageLoaderExceptions",
	"forbiddenImports",
	"forbiddenCalls",
] as const;

const TYPESCRIPT_CLASSES = [
	"officialRoots",
	"roleChildTs",
	"protocolOnlyTs",
	"controllerOnlyTs",
	"fixtureTs",
	"checkerTs",
	"cliEntryTs",
] as const;

type TypeScriptClass = (typeof TYPESCRIPT_CLASSES)[number];

export interface ResolvedStaticImport {
	readonly from: string;
	readonly specifier: string;
	readonly to: string;
	readonly typeOnly: boolean;
}

export interface PackageLoaderException {
	readonly source: string;
	readonly package: string;
	readonly mechanism: "createRequire";
	readonly strictMode: "comparison-supervisor";
	readonly requestPattern: "/dev/fd/<validated-addon-fd>";
	readonly maxAttempts: 1;
	readonly fallbackCandidates: 0;
}

export interface OfficialIoAllowlist {
	readonly officialRoots: readonly string[];
	readonly roleChildTs: readonly string[];
	readonly protocolOnlyTs: readonly string[];
	readonly controllerOnlyTs: readonly string[];
	readonly fixtureTs: readonly string[];
	readonly checkerTs: readonly string[];
	readonly cliEntryTs: readonly string[];
	readonly nativeSources: readonly string[];
	readonly resolvedStaticImports: readonly ResolvedStaticImport[];
	readonly packageLoaderExceptions: readonly PackageLoaderException[];
	readonly forbiddenImports: readonly string[];
	readonly forbiddenCalls: readonly string[];
}

export interface AuditFailure {
	readonly code: string;
	readonly file: string;
	readonly line: number;
	readonly column: number;
	readonly message: string;
}

export interface ClassifiedFile {
	readonly path: string;
	readonly class: TypeScriptClass | "unclassified";
	readonly sha256: string | null;
}

export interface OfficialIoAuditResult {
	readonly schema: typeof OFFICIAL_IO_ALLOWLIST_SCHEMA;
	readonly status: "PASS" | "FAIL";
	readonly classifiedFileSha256: string;
	readonly resolvedGraphSha256: string;
	readonly failureInventorySha256: string;
	readonly failures: readonly AuditFailure[];
	readonly failureCount: number;
	readonly classifiedFiles: readonly ClassifiedFile[];
	readonly resolvedStaticImports: readonly ResolvedStaticImport[];
}

interface AuditOptions {
	readonly repoRoot?: string;
	readonly allowlistPath?: string;
	readonly maxFailures?: number;
}

interface SourceRecord {
	readonly absolutePath: string;
	readonly relativePath: string;
	readonly sourceFile: ts.SourceFile;
	readonly text: string;
}

interface ImportEdge {
	readonly from: string;
	readonly specifier: string;
	readonly to: string;
	readonly typeOnly: boolean;
	readonly absoluteTarget?: string;
}

interface ResolvedTarget {
	readonly to: string;
	readonly absoluteTarget?: string;
	readonly external: boolean;
}

type Identity =
	| string
	| {
			readonly kind: "loader";
			readonly source: string;
	  }
	| undefined;

interface ModuleAnalysis {
	readonly exports: Map<string, Identity>;
	readonly localIdentities: Map<string, Identity>;
}

interface MutableAuditState {
	readonly failures: AuditFailure[];
	readonly sourceByPath: Map<string, SourceRecord>;
	readonly moduleAnalysis: Map<string, ModuleAnalysis>;
	readonly edges: ImportEdge[];
	readonly visited: Set<string>;
	readonly allowlist: OfficialIoAllowlist;
	readonly repoRoot: string;
	readonly maxFailures: number;
}

const packageLoaderSource = "packages/webtransport/src/index.ts";
const packageLoaderPackage = "@webtransport-bun/webtransport";

const NODE_BUILTIN_SPECIFIERS = new Set([
	"fs",
	"fs/promises",
	"path",
	"child_process",
	"module",
	"vm",
	"worker_threads",
	"net",
	"http",
	"https",
	"dgram",
	"tls",
	"process",
	"ffi",
	"stream/web",
	"undici",
]);

const FORBIDDEN_IMPORTS = new Set([
	...NODE_BUILTIN_SPECIFIERS,
	"node:fs",
	"node:fs/promises",
	"node:path",
	"node:child_process",
	"node:module",
	"node:vm",
	"node:worker_threads",
	"node:undici",
	"node:net",
	"node:http",
	"node:https",
	"node:dgram",
	"node:tls",
	"node:process",
	"node:ffi",
	"bun:ffi",
	"ffi-napi",
	"ref-napi",
]);

const FORBIDDEN_CALLS = new Set([
	"import()",
	"require",
	"module.require",
	"createRequire",
	"eval",
	"Function",
	"process.binding",
	"process.dlopen",
	"Bun.dlopen",
	"Bun.file",
	"Bun.write",
	"Bun.spawn",
	"Bun.spawnSync",
	"Bun.connect",
	"Bun.listen",
	"Bun.serve",
	"Bun.env",
	"Bun.argv",
	"Bun.cwd",
	"Bun.open",
	"Deno.Command",
	"Deno.env",
	"Deno.args",
	"Deno.readFile",
	"Deno.readTextFile",
	"Deno.writeFile",
	"Deno.writeTextFile",
	"Deno.open",
	"Deno.readDir",
	"Deno.remove",
	"Deno.rename",
	"Deno.copyFile",
	"Deno.mkdir",
	"Deno.makeTempFile",
	"Deno.stat",
	"Deno.lstat",
	"Deno.realPath",
	"Deno.readLink",
	"Deno.chmod",
	"Deno.chown",
	"Deno.truncate",
	"Deno.watchFs",
	"Deno.cwd",
	"Deno.connect",
	"Deno.listen",
	"fetch",
	"readdir",
	"readdirSync",
	"glob",
	"globSync",
	"measureCellArm",
	"readOfficialComparisonFile",
	"writeOfficialComparisonFile",
	"resolveOfficialComparisonOutputDir",
	"resolveOfficialComparisonOutputFile",
	"assertOfficialComparisonIoAvailable",
	"checkPromotionQuarantine",
	"quarantinePromotion",
	"import.meta.main",
	"process.env",
	"process.cwd",
	"process.argv",
	"process.getBuiltinModule",
	"import.meta.resolve",
	"path.open",
	"path.resolve",
	"path.join",
	"path.dirname",
	"path.basename",
	"path.normalize",
	"addon-loader",
	".node",
	"network",
]);

const FORBIDDEN_GLOBAL_CALLS = new Set([
	"readFile",
	"readFileSync",
	"writeFile",
	"writeFileSync",
	"appendFile",
	"appendFileSync",
	"open",
	"openSync",
	"close",
	"closeSync",
	"stat",
	"statSync",
	"lstat",
	"lstatSync",
	"realpath",
	"realpathSync",
	"mkdir",
	"mkdirSync",
	"rm",
	"rmSync",
	"unlink",
	"unlinkSync",
	"rename",
	"renameSync",
	"copyFile",
	"copyFileSync",
	"watch",
	"watchFile",
	"exec",
	"execFile",
	"spawn",
	"spawnSync",
	"fork",
	"dlopen",
	"CFunction",
	"FFIType",
	"ptr",
]);

const NETWORK_MODULES = new Set([
	"node:net",
	"node:http",
	"node:https",
	"node:dgram",
	"node:tls",
	"node:undici",
	"node:stream/web",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "boolean" || typeof value === "number") {
		if (typeof value === "number" && !Number.isFinite(value)) {
			throw new TypeError("canonical JSON requires finite numbers");
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((child) => canonicalize(child)).join(",")}]`;
	}
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
			.join(",")}}`;
	}
	throw new TypeError(`unsupported canonical value ${typeof value}`);
}

function sha256Bytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function sha256Text(text: string): string {
	return sha256Bytes(new TextEncoder().encode(text));
}

function canonicalSha256(value: unknown): string {
	return sha256Text(canonicalize(value));
}

function normalizedRelativePath(value: string): string {
	return value.split(sep).join("/");
}

function repoRelative(repoRoot: string, absolutePath: string): string {
	return normalizedRelativePath(relative(repoRoot, absolutePath));
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function sortUnique(values: readonly string[]): string[] {
	return [...new Set(values)].sort(compareStrings);
}

function addFailure(state: MutableAuditState, failure: AuditFailure): void {
	if (state.failures.length >= state.maxFailures * 4) return;
	state.failures.push({
		code: failure.code,
		file: normalizedRelativePath(failure.file),
		line: Math.max(1, failure.line),
		column: Math.max(1, failure.column),
		message: failure.message,
	});
}

function nodePosition(
	sourceFile: ts.SourceFile,
	node: ts.Node,
): { readonly line: number; readonly column: number } {
	const location = sourceFile.getLineAndCharacterOfPosition(
		node.getStart(sourceFile),
	);
	return { line: location.line + 1, column: location.character + 1 };
}

function reportNode(
	state: MutableAuditState,
	source: SourceRecord,
	node: ts.Node,
	code: string,
	message: string,
): void {
	const position = nodePosition(source.sourceFile, node);
	addFailure(state, {
		code,
		file: source.relativePath,
		line: position.line,
		column: position.column,
		message,
	});
}

function reportFile(
	state: MutableAuditState,
	file: string,
	code: string,
	message: string,
): void {
	addFailure(state, { code, file, line: 1, column: 1, message });
}

function isBuiltinSpecifier(specifier: string): boolean {
	return (
		specifier.startsWith("node:") ||
		specifier.startsWith("bun:") ||
		specifier.startsWith("deno:")
	);
}

function isWithin(repoRoot: string, candidate: string): boolean {
	const rel = relative(repoRoot, candidate);
	return (
		rel === "" ||
		(rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("/"))
	);
}

/**
 * Resolve a caller-supplied file before opening it.  The checker is an
 * audit boundary, so a lexical path is not enough: a symlinked allowlist (or
 * a path whose parent component is a symlink) must not be able to make the
 * checker read outside the repository it was asked to audit.
 */
function realpathContainedFile(filePath: string, repoRoot: string): string {
	const lexicalRoot = resolve(repoRoot);
	const lexicalFile = resolve(filePath);
	let rootRealPath: string;
	let fileStat: ReturnType<typeof lstatSync>;
	let fileRealPath: string;
	try {
		rootRealPath = resolve(realpathSync(lexicalRoot));
		fileStat = lstatSync(lexicalFile);
		fileRealPath = resolve(realpathSync(lexicalFile));
	} catch (error: unknown) {
		throw new Error(
			`allowlist path cannot be validated before read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (fileStat.isSymbolicLink()) {
		throw new Error("allowlist path must not be a symbolic-link alias");
	}
	if (!fileStat.isFile()) {
		throw new Error("allowlist path must name a regular file");
	}
	if (!isWithin(rootRealPath, fileRealPath) || fileRealPath !== lexicalFile) {
		throw new Error("allowlist path must be realpath-contained in repository");
	}
	return fileRealPath;
}

function createModuleResolutionHostForRoot(
	repoRoot: string,
): ts.ModuleResolutionHost {
	return {
		fileExists: existsSync,
		readFile: (fileName) => {
			try {
				return readFileSync(fileName, "utf8");
			} catch {
				return undefined;
			}
		},
		realpath: (fileName) => fileName,
		directoryExists: (directory) => {
			try {
				return statSync(directory).isDirectory();
			} catch {
				return false;
			}
		},
		getCurrentDirectory: () => repoRoot,
		getDirectories: (directory) => {
			try {
				return readdirSync(directory, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => entry.name);
			} catch {
				return [];
			}
		},
	};
}

function canonicalBuiltinSpecifier(specifier: string): string {
	if (NODE_BUILTIN_SPECIFIERS.has(specifier)) return `node:${specifier}`;
	return specifier;
}

function isForbiddenBuiltinSpecifier(specifier: string): boolean {
	return (
		FORBIDDEN_IMPORTS.has(specifier) ||
		FORBIDDEN_IMPORTS.has(canonicalBuiltinSpecifier(specifier))
	);
}

function resolveTarget(
	repoRoot: string,
	containingFile: string,
	specifier: string,
): ResolvedTarget | undefined {
	if (isBuiltinSpecifier(specifier) || NODE_BUILTIN_SPECIFIERS.has(specifier)) {
		return {
			to: `builtin:${canonicalBuiltinSpecifier(specifier)}`,
			external: true,
		};
	}

	const options: ts.CompilerOptions = {
		allowJs: true,
		module: ts.ModuleKind.Preserve,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		resolvePackageJsonExports: true,
		resolvePackageJsonImports: true,
		allowImportingTsExtensions: true,
		baseUrl: repoRoot,
	};
	const result = ts.resolveModuleName(
		specifier,
		containingFile,
		options,
		createModuleResolutionHostForRoot(repoRoot),
	).resolvedModule;
	if (!result) return undefined;
	const absoluteTarget = resolve(result.resolvedFileName);
	let realTarget: string;
	try {
		realTarget = resolve(realpathSync(absoluteTarget));
	} catch {
		return undefined;
	}
	if (realTarget !== absoluteTarget) return undefined;
	const relativeTarget = repoRelative(repoRoot, absoluteTarget);
	// A package installed under node_modules is an external dependency even
	// though its path is physically below the repository root.  Preserve the
	// absolute target so callers can queue and inspect its transitive surface;
	// the edge still requires explicit approval in the frozen graph contract.
	if (
		!isWithin(repoRoot, absoluteTarget) ||
		relativeTarget === "node_modules" ||
		relativeTarget.startsWith("node_modules/")
	) {
		return { to: `external:${specifier}`, absoluteTarget, external: true };
	}
	return {
		to: relativeTarget,
		absoluteTarget,
		external: false,
	};
}

function parseSource(
	state: MutableAuditState,
	absolutePath: string,
): SourceRecord | undefined {
	const normalizedPath = resolve(absolutePath);
	const relativePath = repoRelative(state.repoRoot, normalizedPath);
	let realPath: string;
	try {
		realPath = resolve(realpathSync(normalizedPath));
	} catch {
		reportFile(
			state,
			relativePath,
			"SOURCE_REALPATH_FAILED",
			"cannot establish a realpath-contained source identity",
		);
		return undefined;
	}
	if (realPath !== normalizedPath || !isWithin(state.repoRoot, realPath)) {
		reportFile(
			state,
			relativePath,
			"SOURCE_PATH_INVALID",
			"source path is a symbolic-link alias or escapes the repository root",
		);
		return undefined;
	}
	const existing = state.sourceByPath.get(relativePath);
	if (existing) return existing;
	let text: string;
	try {
		text = readFileSync(normalizedPath, "utf8");
	} catch (error: unknown) {
		reportFile(
			state,
			relativePath,
			"SOURCE_READ_FAILED",
			`cannot read source: ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
	const sourceFile = ts.createSourceFile(
		normalizedPath,
		text,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const parseDiagnostics =
		(
			sourceFile as ts.SourceFile & {
				readonly parseDiagnostics?: readonly ts.Diagnostic[];
			}
		).parseDiagnostics ?? [];
	for (const diagnostic of parseDiagnostics) {
		const position = sourceFile.getLineAndCharacterOfPosition(
			diagnostic.start ?? 0,
		);
		addFailure(state, {
			code: "SOURCE_PARSE_ERROR",
			file: relativePath,
			line: position.line + 1,
			column: position.character + 1,
			message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
		});
	}
	const source = { absolutePath, relativePath, sourceFile, text };
	state.sourceByPath.set(relativePath, source);
	return source;
}

function literalText(
	node: ts.Expression | ts.LiteralTypeNode,
): string | undefined {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
		return node.text;
	}
	if (ts.isTemplateExpression(node) && node.templateSpans.length === 0) {
		return node.head.text;
	}
	return undefined;
}

function unwrappedLiteralText(
	node: ts.Expression | undefined,
): string | undefined {
	if (!node) return undefined;
	if (ts.isParenthesizedExpression(node))
		return unwrappedLiteralText(node.expression);
	if (
		ts.isAsExpression(node) ||
		ts.isTypeAssertionExpression(node) ||
		ts.isNonNullExpression(node) ||
		ts.isSatisfiesExpression(node)
	)
		return unwrappedLiteralText(node.expression);
	return literalText(node);
}

function propertyNameText(
	name: ts.PropertyName | undefined,
): string | undefined {
	if (!name) return undefined;
	if (
		ts.isIdentifier(name) ||
		ts.isStringLiteral(name) ||
		ts.isNumericLiteral(name)
	) {
		return name.text;
	}
	if (ts.isComputedPropertyName(name)) {
		return literalText(name.expression);
	}
	return undefined;
}

function isImportMetaMain(node: ts.Node): boolean {
	return (
		ts.isPropertyAccessExpression(node) &&
		ts.isMetaProperty(node.expression) &&
		node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
		node.expression.name.text === "meta" &&
		node.name.text === "main"
	);
}

function isImportMetaResolve(node: ts.Node): boolean {
	return (
		ts.isPropertyAccessExpression(node) &&
		ts.isMetaProperty(node.expression) &&
		node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
		node.expression.name.text === "meta" &&
		node.name.text === "resolve"
	);
}

function bindingNames(
	pattern: ts.BindingName,
): Array<{ name: string; property?: string }> {
	if (ts.isIdentifier(pattern)) return [{ name: pattern.text }];
	const result: Array<{ name: string; property?: string }> = [];
	for (const element of pattern.elements) {
		if (ts.isOmittedExpression(element)) continue;
		const property =
			propertyNameText(element.propertyName) ??
			(ts.isIdentifier(element.name) ? element.name.text : undefined);
		for (const nested of bindingNames(element.name)) {
			result.push({
				name: nested.name,
				property: nested.property ?? property,
			});
		}
	}
	return result;
}

function isAssignmentPattern(
	node: ts.Node,
): node is ts.ObjectLiteralExpression | ts.ArrayLiteralExpression {
	return (
		ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)
	);
}

function assignmentPatternProperties(
	pattern: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
): Array<{
	readonly node: ts.Node;
	readonly property?: string;
	readonly computed: boolean;
}> {
	const result: Array<{
		readonly node: ts.Node;
		readonly property?: string;
		readonly computed: boolean;
	}> = [];
	const elements: readonly ts.Node[] = ts.isObjectLiteralExpression(pattern)
		? [...pattern.properties]
		: [...pattern.elements];
	for (const element of elements) {
		if (ts.isSpreadAssignment(element) || ts.isSpreadElement(element)) {
			result.push({ node: element, computed: true });
			continue;
		}
		if (ts.isPropertyAssignment(element)) {
			const property = propertyNameText(element.name);
			const computed = ts.isComputedPropertyName(element.name);
			if (isAssignmentPattern(element.initializer)) {
				for (const nested of assignmentPatternProperties(element.initializer)) {
					result.push({
						node: nested.node,
						property: nested.property ?? property,
						computed: computed || nested.computed,
					});
				}
			} else {
				result.push({
					node: element.initializer,
					property,
					computed,
				});
			}
			continue;
		}
		if (ts.isShorthandPropertyAssignment(element)) {
			result.push({
				node: element.name,
				property: element.name.text,
				computed: false,
			});
		}
	}
	return result;
}

function assignmentTargetNames(expression: ts.Expression): Set<string> {
	const names = new Set<string>();
	function visit(target: ts.Expression): void {
		if (ts.isIdentifier(target)) {
			names.add(target.text);
			return;
		}
		if (
			ts.isPropertyAccessExpression(target) ||
			ts.isElementAccessExpression(target)
		) {
			visit(target.expression);
			return;
		}
		if (ts.isBinaryExpression(target)) {
			if (target.operatorToken.kind === ts.SyntaxKind.EqualsToken)
				visit(target.left as ts.Expression);
			return;
		}
		if (ts.isObjectLiteralExpression(target)) {
			for (const element of target.properties) {
				if (ts.isSpreadAssignment(element)) visit(element.expression);
				else if (ts.isShorthandPropertyAssignment(element))
					names.add(element.name.text);
				else if (ts.isPropertyAssignment(element)) visit(element.initializer);
			}
			return;
		}
		if (ts.isArrayLiteralExpression(target)) {
			for (const element of target.elements) {
				if (ts.isOmittedExpression(element)) continue;
				if (ts.isSpreadElement(element)) visit(element.expression);
				else visit(element);
			}
		}
	}
	visit(expression);
	return names;
}

function moduleSpecifierText(
	node: ts.Expression | undefined,
): string | undefined {
	return node &&
		(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
		? node.text
		: undefined;
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
	if (node.importClause?.isTypeOnly) return true;
	const named = node.importClause?.namedBindings;
	return (
		!!named &&
		ts.isNamedImports(named) &&
		named.elements.length > 0 &&
		named.elements.every((element) => element.isTypeOnly)
	);
}

function addResolvedEdge(
	state: MutableAuditState,
	source: SourceRecord,
	specifier: string,
	typeOnly: boolean,
	node: ts.Node,
	recordEdge = true,
): ResolvedTarget | undefined {
	const target = resolveTarget(state.repoRoot, source.absolutePath, specifier);
	if (!target) {
		reportNode(
			state,
			source,
			node,
			"UNRESOLVED_STATIC_IMPORT",
			`static import '${specifier}' does not resolve`,
		);
		return undefined;
	}
	if (target.external && !target.to.startsWith("builtin:")) {
		reportNode(
			state,
			source,
			node,
			"UNAPPROVED_EXTERNAL_TARGET",
			`resolved static import '${specifier}' targets an unapproved external module`,
		);
	}
	if (target.to.startsWith("builtin:")) {
		const resolvedBuiltin = target.to.slice("builtin:".length);
		if (
			isForbiddenBuiltinSpecifier(resolvedBuiltin) &&
			!isForbiddenBuiltinSpecifier(specifier)
		) {
			reportNode(
				state,
				source,
				node,
				"FORBIDDEN_RESOLVED_IMPORT",
				`resolved static import '${specifier}' targets forbidden builtin '${resolvedBuiltin}'`,
			);
		}
	}
	if (recordEdge) {
		state.edges.push({
			from: source.relativePath,
			specifier,
			to: target.to,
			typeOnly,
			...(target.absoluteTarget
				? { absoluteTarget: target.absoluteTarget }
				: {}),
		});
	}
	return target;
}

function getModuleExports(): ModuleAnalysis {
	return {
		exports: new Map<string, Identity>(),
		localIdentities: new Map<string, Identity>(),
	};
}

function getStringProperty(node: ts.Expression): string | undefined {
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
	if (ts.isElementAccessExpression(node)) {
		return node.argumentExpression
			? literalText(node.argumentExpression)
			: undefined;
	}
	return undefined;
}

function identityName(identity: Identity): string | undefined {
	return typeof identity === "string" ? identity : undefined;
}

function propertyIdentity(
	base: Identity,
	property: string,
	identities: Map<string, Identity>,
): Identity {
	if (!base || !property || isLoaderIdentity(base)) return undefined;
	const baseName = identityName(base);
	if (!baseName) return undefined;
	return identities.get(`${baseName}.${property}`) ?? `${baseName}.${property}`;
}

function isAmbientNamespaceIdentity(identity: Identity): boolean {
	const name = identityName(identity);
	if (!name) return false;
	if (
		name === "import.meta" ||
		name === "Bun" ||
		name === "Deno" ||
		name === "process" ||
		name === "module" ||
		name.endsWith(".Bun") ||
		name.endsWith(".Deno") ||
		name.endsWith(".process") ||
		name.endsWith(".module")
	) {
		return true;
	}
	if (!name.startsWith("module:")) return false;
	// Only builtin and external module namespaces hide their member set from
	// static review; repository-local modules resolve to an enumerable export
	// set, so computed access into them cannot reach a forbidden surface that
	// the per-member rules would not already see (amendment: "Equivalent
	// alias/computed/re-export spellings are rejected" — spellings OF the
	// enumerated surfaces, not arbitrary local values).
	const suffix = name.slice("module:".length);
	return (
		!suffix.startsWith("./") &&
		!suffix.startsWith("../") &&
		!suffix.startsWith("/")
	);
}

function identityForExpression(
	expression: ts.Expression | undefined,
	identities: Map<string, Identity>,
	depth = 0,
): Identity {
	if (!expression || depth > 12) return undefined;
	if (ts.isParenthesizedExpression(expression)) {
		return identityForExpression(expression.expression, identities, depth + 1);
	}
	if (
		ts.isAsExpression(expression) ||
		ts.isTypeAssertionExpression(expression) ||
		ts.isSatisfiesExpression(expression)
	) {
		return identityForExpression(expression.expression, identities, depth + 1);
	}
	if (ts.isNonNullExpression(expression)) {
		return identityForExpression(expression.expression, identities, depth + 1);
	}
	if (
		ts.isMetaProperty(expression) &&
		expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
		expression.name.text === "meta"
	) {
		return "import.meta";
	}
	if (ts.isIdentifier(expression)) {
		return identities.get(expression.text) ?? expression.text;
	}
	if (
		ts.isPropertyAccessExpression(expression) ||
		ts.isElementAccessExpression(expression)
	) {
		const base = identityForExpression(
			expression.expression,
			identities,
			depth + 1,
		);
		const property = getStringProperty(expression);
		if (base && property) return propertyIdentity(base, property, identities);
		return undefined;
	}
	if (ts.isCallExpression(expression)) {
		const called = identityForExpression(
			expression.expression,
			identities,
			depth + 1,
		);
		const calledName = identityName(called);
		if (calledName === "module:node:module.createRequire") {
			return { kind: "loader", source: "" };
		}
	}
	return undefined;
}

function importIdentity(
	specifier: string,
	importedName: string,
	targetSource: SourceRecord | undefined,
	moduleExports: Map<string, Map<string, Identity>>,
): Identity {
	const canonicalSpecifier = canonicalBuiltinSpecifier(specifier);
	if (targetSource) {
		const targetExports = moduleExports.get(targetSource.relativePath);
		const exported = targetExports?.get(importedName);
		if (exported) return exported;
		const wildcard = targetExports?.get("*");
		if (typeof wildcard === "string") {
			return `${wildcard}.${importedName}`;
		}
	}
	if (specifier === "bun" || specifier === "bun:ffi")
		return `Bun.${importedName}`;
	if (specifier === "deno" || specifier.startsWith("deno:"))
		return `Deno.${importedName}`;
	return `module:${canonicalSpecifier}.${importedName}`;
}

function namespaceIdentityForSpecifier(specifier: string): string {
	if (specifier === "bun" || specifier === "bun:") return "Bun";
	if (specifier === "deno" || specifier.startsWith("deno:")) return "Deno";
	return `module:${canonicalBuiltinSpecifier(specifier)}`;
}

function hasExportModifier(node: ts.Node): boolean {
	return ts.canHaveModifiers(node)
		? ts
				.getModifiers(node)
				?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
				true
		: false;
}

function recordImportBindings(
	state: MutableAuditState,
	source: SourceRecord,
	moduleExports: Map<string, Map<string, Identity>>,
	node: ts.ImportDeclaration,
): Map<string, Identity> {
	const identities = new Map<string, Identity>();
	const specifier = moduleSpecifierText(node.moduleSpecifier);
	if (!specifier) return identities;
	const target = resolveTarget(state.repoRoot, source.absolutePath, specifier);
	const targetSource = target?.absoluteTarget
		? parseSource(state, target.absoluteTarget)
		: undefined;
	const namespace = node.importClause?.namedBindings;
	if (node.importClause?.name) {
		identities.set(
			node.importClause.name.text,
			importIdentity(specifier, "default", targetSource, moduleExports),
		);
	}
	if (namespace && ts.isNamespaceImport(namespace)) {
		const namespaceIdentity = namespaceIdentityForSpecifier(specifier);
		identities.set(namespace.name.text, namespaceIdentity);
		const targetExports = targetSource
			? moduleExports.get(targetSource.relativePath)
			: undefined;
		for (const [exportedName, identity] of targetExports ?? []) {
			if (exportedName !== "*") {
				identities.set(`${namespaceIdentity}.${exportedName}`, identity);
			}
		}
	} else if (namespace && ts.isNamedImports(namespace)) {
		for (const element of namespace.elements) {
			const imported = element.propertyName?.text ?? element.name.text;
			identities.set(
				element.name.text,
				importIdentity(specifier, imported, targetSource, moduleExports),
			);
		}
	}
	return identities;
}

function collectLocalIdentities(
	state: MutableAuditState,
	source: SourceRecord,
	moduleExports: Map<string, Map<string, Identity>>,
): ModuleAnalysis {
	const analysis = getModuleExports();
	const sourceFile = source.sourceFile;

	function visit(node: ts.Node): void {
		if (ts.isImportDeclaration(node)) {
			for (const [name, identity] of recordImportBindings(
				state,
				source,
				moduleExports,
				node,
			)) {
				analysis.localIdentities.set(name, identity);
			}
		}
		if (ts.isVariableDeclaration(node)) {
			const initializerIdentity = identityForExpression(
				node.initializer,
				analysis.localIdentities,
			);
			if (node.name.kind === ts.SyntaxKind.Identifier && initializerIdentity) {
				analysis.localIdentities.set(
					node.name.getText(sourceFile),
					initializerIdentity,
				);
				if (
					ts.isVariableDeclarationList(node.parent) &&
					ts.isVariableStatement(node.parent.parent) &&
					hasExportModifier(node.parent.parent)
				) {
					analysis.exports.set(
						node.name.getText(sourceFile),
						initializerIdentity,
					);
				}
			} else if (
				node.name.kind !== ts.SyntaxKind.Identifier &&
				initializerIdentity
			) {
				for (const binding of bindingNames(node.name)) {
					if (binding.property) {
						const property = propertyIdentity(
							initializerIdentity,
							binding.property,
							analysis.localIdentities,
						);
						if (property) {
							analysis.localIdentities.set(binding.name, property);
						}
					}
				}
			}
		}
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			ts.isIdentifier(node.left)
		) {
			const assignedIdentity = identityForExpression(
				node.right,
				analysis.localIdentities,
			);
			if (assignedIdentity) {
				analysis.localIdentities.set(node.left.text, assignedIdentity);
			}
		}
		if (ts.isFunctionDeclaration(node) && node.name) {
			analysis.localIdentities.set(node.name.text, node.name.text);
			if (hasExportModifier(node)) {
				analysis.exports.set(
					node.modifiers?.some(
						(modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
					)
						? "default"
						: node.name.text,
					node.name.text,
				);
			}
		}
		if (ts.isClassDeclaration(node) && node.name) {
			analysis.localIdentities.set(node.name.text, node.name.text);
			if (hasExportModifier(node)) {
				analysis.exports.set(
					node.modifiers?.some(
						(modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
					)
						? "default"
						: node.name.text,
					node.name.text,
				);
			}
		}
		if (ts.isExportDeclaration(node)) {
			const specifier = moduleSpecifierText(node.moduleSpecifier);
			if (
				!specifier &&
				node.exportClause &&
				ts.isNamedExports(node.exportClause)
			) {
				for (const element of node.exportClause.elements) {
					const localName = element.propertyName?.text ?? element.name.text;
					const identity = analysis.localIdentities.get(localName);
					if (identity) analysis.exports.set(element.name.text, identity);
				}
			}
			if (
				specifier &&
				node.exportClause &&
				ts.isNamedExports(node.exportClause)
			) {
				const target = resolveTarget(
					state.repoRoot,
					source.absolutePath,
					specifier,
				);
				const targetSource = target?.absoluteTarget
					? parseSource(state, target.absoluteTarget)
					: undefined;
				for (const element of node.exportClause.elements) {
					const imported = element.propertyName?.text ?? element.name.text;
					const identity = importIdentity(
						specifier,
						imported,
						targetSource,
						moduleExports,
					);
					analysis.exports.set(element.name.text, identity);
				}
			} else if (
				specifier &&
				node.exportClause &&
				ts.isNamespaceExport(node.exportClause)
			) {
				analysis.exports.set(
					node.exportClause.name.text,
					namespaceIdentityForSpecifier(specifier),
				);
			} else if (specifier && !node.exportClause) {
				const target = resolveTarget(
					state.repoRoot,
					source.absolutePath,
					specifier,
				);
				const targetSource = target?.absoluteTarget
					? parseSource(state, target.absoluteTarget)
					: undefined;
				const targetExports = targetSource
					? moduleExports.get(targetSource.relativePath)
					: undefined;
				if (targetExports) {
					for (const [name, identity] of targetExports) {
						analysis.exports.set(name, identity);
					}
				} else {
					analysis.exports.set("*", namespaceIdentityForSpecifier(specifier));
				}
			}
		}
		if (ts.isExportAssignment(node)) {
			const identity = identityForExpression(
				node.expression,
				analysis.localIdentities,
			);
			if (identity) analysis.exports.set("default", identity);
		}
		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return analysis;
}

function isLoaderIdentity(identity: Identity): boolean {
	return typeof identity === "object" && identity.kind === "loader";
}

interface LoaderProofValidation {
	readonly start: number;
	readonly owner: ts.Node | undefined;
	readonly source: string;
}

interface LoaderProof {
	readonly trustedFdBindings: ReadonlySet<string>;
	readonly trustedDigestBindings: ReadonlySet<string>;
	readonly validatedBindings: ReadonlySet<string>;
	readonly strictAuthority: boolean;
	readonly validatedPair: boolean;
	readonly isValidatedFdExpression: (
		expression: ts.Expression | undefined,
		useNode: ts.Node,
	) => boolean;
}

function isUserControlledExpression(node: ts.Node): boolean {
	let userControlled = false;
	function visit(child: ts.Node): void {
		if (ts.isIdentifier(child)) {
			const name = child.text.toLowerCase();
			if (
				name === "process" ||
				name === "argv" ||
				name === "env" ||
				name.includes("user") ||
				name.includes("input") ||
				name.includes("argument") ||
				name.includes("request")
			) {
				userControlled = true;
			}
		}
		if (isImportMetaResolve(child)) userControlled = true;
		if (ts.isPropertyAccessExpression(child) && child.name.text === "url") {
			if (ts.isMetaProperty(child.expression)) userControlled = true;
		}
		if (!userControlled) ts.forEachChild(child, visit);
	}
	visit(node);
	return userControlled;
}

function isAuthorityCall(
	node: ts.CallExpression,
	supervisorBindings: ReadonlySet<string>,
	strictModeBindings: ReadonlySet<string> = new Set(),
): boolean {
	if (!ts.isPropertyAccessExpression(node.expression)) return false;
	if (node.expression.name.text !== "issueAddonDescriptor") return false;
	if (!ts.isIdentifier(node.expression.expression)) return false;
	if (!supervisorBindings.has(node.expression.expression.text)) return false;
	if (node.arguments.length !== 1) return false;
	const mode = node.arguments[0];
	if (!mode) return false;
	return (
		unwrappedLiteralText(mode) === "comparison-supervisor" ||
		(ts.isIdentifier(mode) && strictModeBindings.has(mode.text))
	);
}

function collectLoaderProof(
	state: MutableAuditState,
	source: SourceRecord,
): LoaderProof {
	const supervisorBindings = collectSupervisorAuthorityBindings(state, source);
	const declarations: ts.VariableDeclaration[] = [];
	const assignments: ts.BinaryExpression[] = [];
	const calls: ts.CallExpression[] = [];
	const authorityCandidates: ts.CallExpression[] = [];
	const validationCandidates: ts.CallExpression[] = [];
	const writes = new Set<string>();

	function unwrapProofExpression(
		expression: ts.Expression | undefined,
	): ts.Expression | undefined {
		if (!expression) return undefined;
		if (ts.isParenthesizedExpression(expression))
			return unwrapProofExpression(expression.expression);
		if (
			ts.isAsExpression(expression) ||
			ts.isTypeAssertionExpression(expression) ||
			ts.isNonNullExpression(expression) ||
			ts.isSatisfiesExpression(expression)
		)
			return unwrapProofExpression(expression.expression);
		return expression;
	}

	function staticStringValue(
		expression: ts.Expression | undefined,
	): string | undefined {
		const unwrapped = unwrapProofExpression(expression);
		return unwrapped &&
			(ts.isStringLiteral(unwrapped) ||
				ts.isNoSubstitutionTemplateLiteral(unwrapped))
			? unwrapped.text
			: undefined;
	}

	function assignmentTargetExpressions(
		expression: ts.Expression,
	): ts.Expression[] {
		if (
			ts.isIdentifier(expression) ||
			ts.isPropertyAccessExpression(expression) ||
			ts.isElementAccessExpression(expression)
		)
			return [expression];
		if (ts.isBinaryExpression(expression)) {
			if (expression.operatorToken.kind === ts.SyntaxKind.EqualsToken)
				return assignmentTargetExpressions(expression.left as ts.Expression);
			return [];
		}
		if (ts.isObjectLiteralExpression(expression)) {
			const result: ts.Expression[] = [];
			for (const element of expression.properties) {
				if (ts.isSpreadAssignment(element)) {
					result.push(...assignmentTargetExpressions(element.expression));
				} else if (ts.isShorthandPropertyAssignment(element)) {
					result.push(element.name);
				} else if (ts.isPropertyAssignment(element)) {
					result.push(...assignmentTargetExpressions(element.initializer));
				}
			}
			return result;
		}
		if (ts.isArrayLiteralExpression(expression)) {
			const result: ts.Expression[] = [];
			for (const element of expression.elements) {
				if (ts.isOmittedExpression(element)) continue;
				if (ts.isSpreadElement(element)) {
					result.push(...assignmentTargetExpressions(element.expression));
				} else {
					result.push(...assignmentTargetExpressions(element));
				}
			}
			return result;
		}
		return [];
	}

	function isFunctionBoundary(node: ts.Node): boolean {
		return (
			ts.isFunctionDeclaration(node) ||
			ts.isFunctionExpression(node) ||
			ts.isArrowFunction(node) ||
			ts.isMethodDeclaration(node) ||
			ts.isGetAccessorDeclaration(node) ||
			ts.isSetAccessorDeclaration(node) ||
			ts.isConstructorDeclaration(node)
		);
	}

	function functionOwner(node: ts.Node): ts.Node | undefined {
		let parent = node.parent;
		while (parent) {
			if (isFunctionBoundary(parent)) return parent;
			parent = parent.parent;
		}
		return undefined;
	}

	function isUnconditional(node: ts.Node): boolean {
		const owner = functionOwner(node);
		let parent = node.parent;
		let child: ts.Node = node;
		while (parent && parent !== owner) {
			if (
				ts.isSourceFile(parent) ||
				ts.isBlock(parent) ||
				ts.isModuleBlock(parent)
			) {
				let statement = child;
				while (statement.parent && statement.parent !== parent)
					statement = statement.parent;
				const statementIndex = parent.statements.indexOf(
					statement as ts.Statement,
				);
				if (statementIndex >= 0) {
					for (const prior of parent.statements.slice(0, statementIndex)) {
						if (
							ts.isReturnStatement(prior) ||
							ts.isThrowStatement(prior) ||
							ts.isBreakStatement(prior) ||
							ts.isContinueStatement(prior)
						) {
							return false;
						}
					}
				}
			}
			if (
				ts.isIfStatement(parent) ||
				ts.isSwitchStatement(parent) ||
				ts.isCaseClause(parent) ||
				ts.isDefaultClause(parent) ||
				ts.isForStatement(parent) ||
				ts.isForInStatement(parent) ||
				ts.isForOfStatement(parent) ||
				ts.isWhileStatement(parent) ||
				ts.isDoStatement(parent) ||
				ts.isTryStatement(parent) ||
				ts.isCatchClause(parent) ||
				ts.isConditionalExpression(parent) ||
				(ts.isBinaryExpression(parent) &&
					(parent.operatorToken.kind ===
						ts.SyntaxKind.AmpersandAmpersandToken ||
						parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
						parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
						parent.operatorToken.kind === ts.SyntaxKind.CommaToken))
			) {
				return false;
			}
			child = parent;
			parent = parent.parent;
		}
		return parent === owner;
	}

	function isAuthoritySyntax(node: ts.CallExpression): boolean {
		return (
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === "issueAddonDescriptor" &&
			ts.isIdentifier(node.expression.expression) &&
			supervisorBindings.has(node.expression.expression.text) &&
			node.arguments.length === 1
		);
	}

	function isValidationSyntax(node: ts.CallExpression): boolean {
		return (
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === "validatePreopenedAddonDescriptor" &&
			ts.isIdentifier(node.expression.expression) &&
			supervisorBindings.has(node.expression.expression.text) &&
			node.arguments.length === 2
		);
	}

	function visit(node: ts.Node): void {
		if (ts.isVariableDeclaration(node)) declarations.push(node);
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken
		) {
			assignments.push(node);
			for (const target of assignmentTargetExpressions(
				node.left as ts.Expression,
			)) {
				if (ts.isIdentifier(target)) writes.add(target.text);
			}
		}
		if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
			if (
				node.operator === ts.SyntaxKind.PlusPlusToken ||
				node.operator === ts.SyntaxKind.MinusMinusToken
			) {
				const operand = unwrapProofExpression(node.operand);
				if (operand && ts.isIdentifier(operand)) writes.add(operand.text);
			}
		}
		if (ts.isDeleteExpression(node)) {
			for (const name of assignmentTargetNames(node.expression))
				writes.add(name);
		}
		if (ts.isCallExpression(node)) {
			calls.push(node);
			if (isAuthoritySyntax(node)) authorityCandidates.push(node);
			if (isValidationSyntax(node)) validationCandidates.push(node);
		}
		ts.forEachChild(node, visit);
	}
	visit(source.sourceFile);
	declarations.sort(
		(left, right) =>
			left.getStart(source.sourceFile) - right.getStart(source.sourceFile),
	);
	calls.sort(
		(left, right) =>
			left.getStart(source.sourceFile) - right.getStart(source.sourceFile),
	);

	// A strict authority mode is a const dataflow fact, not a spelling
	// convention.  In particular, `strictMode` and `comparisonMode` are just
	// ordinary identifiers until their own immutable literal provenance is
	// proven.
	const strictCandidates = new Set<string>();
	for (const declaration of declarations) {
		if (
			ts.isIdentifier(declaration.name) &&
			declaration.initializer &&
			ts.isVariableDeclarationList(declaration.parent) &&
			(declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
			staticStringValue(declaration.initializer) === "comparison-supervisor"
		) {
			strictCandidates.add(declaration.name.text);
		}
	}
	for (let round = 0; round < declarations.length + 2; round += 1) {
		let changed = false;
		for (const declaration of declarations) {
			const initializer = unwrapProofExpression(declaration.initializer);
			if (
				!ts.isIdentifier(declaration.name) ||
				!declaration.initializer ||
				!ts.isVariableDeclarationList(declaration.parent) ||
				(declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
				!initializer ||
				!ts.isIdentifier(initializer)
			)
				continue;
			if (
				strictCandidates.has(initializer.text) &&
				!strictCandidates.has(declaration.name.text)
			) {
				strictCandidates.add(declaration.name.text);
				changed = true;
			}
		}
		if (!changed) break;
	}
	for (const name of writes) strictCandidates.delete(name);
	const strictModeBindings = strictCandidates;

	const authorityByStart = new Map<number, string>();
	for (const call of authorityCandidates) {
		if (!isAuthorityCall(call, supervisorBindings, strictModeBindings))
			continue;
		if (!isUnconditional(call)) continue;
		authorityByStart.set(
			call.getStart(source.sourceFile),
			`authority:${call.getStart(source.sourceFile)}`,
		);
	}

	type ProofField = {
		readonly source: string;
		readonly kind: "fd" | "digest";
	};
	const descriptorSources = new Map<string, string>();
	const validatedSources = new Map<string, string>();
	const fields = new Map<string, ProofField>();
	const invalidNames = new Set<string>();
	const invalidSources = new Set<string>();
	const validationByStart = new Map<number, LoaderProofValidation>();

	function propertyOf(expression: ts.Expression): string | undefined {
		if (
			!ts.isPropertyAccessExpression(expression) &&
			!ts.isElementAccessExpression(expression)
		)
			return undefined;
		return getStringProperty(expression);
	}

	function sourceForExpression(
		expression: ts.Expression | undefined,
	): string | undefined {
		const unwrapped = unwrapProofExpression(expression);
		if (!unwrapped) return undefined;
		if (ts.isIdentifier(unwrapped)) {
			if (invalidNames.has(unwrapped.text)) return undefined;
			return (
				descriptorSources.get(unwrapped.text) ??
				validatedSources.get(unwrapped.text)
			);
		}
		if (ts.isCallExpression(unwrapped)) {
			return (
				authorityByStart.get(unwrapped.getStart(source.sourceFile)) ??
				validationByStart.get(unwrapped.getStart(source.sourceFile))?.source
			);
		}
		if (
			ts.isPropertyAccessExpression(unwrapped) ||
			ts.isElementAccessExpression(unwrapped)
		) {
			const base = sourceForExpression(unwrapped.expression);
			const property = propertyOf(unwrapped);
			if (!base || !property || invalidSources.has(base)) return undefined;
			if (property === "descriptor") return base;
			if (
				property === "fd" ||
				property === "addonFd" ||
				property === "digest" ||
				property === "identitySha256" ||
				property === "sha256"
			)
				return base;
		}
		return undefined;
	}

	function fieldForExpression(
		expression: ts.Expression | undefined,
	): ProofField | undefined {
		const unwrapped = unwrapProofExpression(expression);
		if (!unwrapped || isUserControlledExpression(unwrapped)) return undefined;
		if (ts.isIdentifier(unwrapped)) {
			if (invalidNames.has(unwrapped.text)) return undefined;
			const field = fields.get(unwrapped.text);
			return field && !invalidSources.has(field.source) ? field : undefined;
		}
		if (
			!ts.isPropertyAccessExpression(unwrapped) &&
			!ts.isElementAccessExpression(unwrapped)
		)
			return undefined;
		const base = sourceForExpression(unwrapped.expression);
		const property = propertyOf(unwrapped);
		if (!base || !property || invalidSources.has(base)) return undefined;
		if (property === "fd" || property === "addonFd")
			return { source: base, kind: "fd" };
		if (
			property === "digest" ||
			property === "identitySha256" ||
			property === "sha256"
		)
			return { source: base, kind: "digest" };
		return undefined;
	}

	function applyDeclaration(declaration: ts.VariableDeclaration): void {
		const initializer = declaration.initializer;
		if (!initializer) return;
		const sourceValue = sourceForExpression(initializer);
		if (ts.isIdentifier(declaration.name)) {
			const name = declaration.name.text;
			if (
				authorityByStart.has(initializer.getStart(source.sourceFile)) &&
				sourceValue
			) {
				descriptorSources.set(name, sourceValue);
				return;
			}
			const field = fieldForExpression(initializer);
			if (field) fields.set(name, field);
			if (
				validationByStart.has(initializer.getStart(source.sourceFile)) &&
				sourceValue
			)
				validatedSources.set(name, sourceValue);
			if (sourceValue && !field) descriptorSources.set(name, sourceValue);
			return;
		}
		if (!sourceValue) return;
		for (const binding of bindingNames(declaration.name)) {
			if (!binding.property) continue;
			if (binding.property === "descriptor")
				descriptorSources.set(binding.name, sourceValue);
			if (binding.property === "fd" || binding.property === "addonFd")
				fields.set(binding.name, { source: sourceValue, kind: "fd" });
			if (
				binding.property === "digest" ||
				binding.property === "identitySha256" ||
				binding.property === "sha256"
			)
				fields.set(binding.name, { source: sourceValue, kind: "digest" });
		}
	}

	for (let round = 0; round < declarations.length + 4; round += 1) {
		const before = descriptorSources.size + validatedSources.size + fields.size;
		for (const declaration of declarations) applyDeclaration(declaration);
		const after = descriptorSources.size + validatedSources.size + fields.size;
		if (before === after) break;
	}

	function markMutation(expression: ts.Expression | undefined): void {
		const unwrapped = unwrapProofExpression(expression);
		if (!unwrapped) return;
		if (isAssignmentPattern(unwrapped)) {
			for (const target of assignmentTargetExpressions(unwrapped))
				markMutation(target);
			return;
		}
		if (ts.isIdentifier(unwrapped)) {
			const sourceValue =
				descriptorSources.get(unwrapped.text) ??
				validatedSources.get(unwrapped.text) ??
				fields.get(unwrapped.text)?.source;
			invalidNames.add(unwrapped.text);
			if (sourceValue) invalidSources.add(sourceValue);
			return;
		}
		if (
			ts.isPropertyAccessExpression(unwrapped) ||
			ts.isElementAccessExpression(unwrapped)
		) {
			const sourceValue = sourceForExpression(unwrapped.expression);
			if (sourceValue) invalidSources.add(sourceValue);
		}
	}

	for (const assignment of assignments)
		markMutation(assignment.left as ts.Expression);
	for (const call of calls) {
		if (
			authorityByStart.has(call.getStart(source.sourceFile)) ||
			isValidationSyntax(call)
		)
			continue;
		const expression = unwrapProofExpression(call.expression);
		const callName =
			expression &&
			(ts.isPropertyAccessExpression(expression) ||
				ts.isElementAccessExpression(expression))
				? `${expression.expression.getText(source.sourceFile)}.${getStringProperty(expression) ?? ""}`
				: undefined;
		if (
			callName === "Object.assign" ||
			callName === "Object.defineProperty" ||
			callName === "Reflect.set"
		) {
			markMutation(call.arguments[0]);
		}
		for (const argument of call.arguments) {
			const unwrapped = unwrapProofExpression(argument);
			if (
				unwrapped &&
				(ts.isIdentifier(unwrapped) ||
					ts.isPropertyAccessExpression(unwrapped) ||
					ts.isElementAccessExpression(unwrapped))
			)
				markMutation(unwrapped);
		}
	}
	const sourceMutatingNodes: ts.Node[] = [];
	function collectPropertyMutations(node: ts.Node): void {
		if (ts.isDeleteExpression(node)) sourceMutatingNodes.push(node.expression);
		if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
			if (
				node.operator === ts.SyntaxKind.PlusPlusToken ||
				node.operator === ts.SyntaxKind.MinusMinusToken
			)
				sourceMutatingNodes.push(node.operand);
		}
		ts.forEachChild(node, collectPropertyMutations);
	}
	collectPropertyMutations(source.sourceFile);
	for (const node of sourceMutatingNodes) markMutation(node as ts.Expression);

	const validatedBindings = new Set<string>();
	for (const call of validationCandidates) {
		if (!isUnconditional(call)) continue;
		const first = fieldForExpression(call.arguments[0]);
		const second = fieldForExpression(call.arguments[1]);
		if (
			!first ||
			!second ||
			first.source !== second.source ||
			first.kind === second.kind ||
			invalidSources.has(first.source)
		)
			continue;
		const record: LoaderProofValidation = {
			start: call.getStart(source.sourceFile),
			owner: functionOwner(call),
			source: first.source,
		};
		validationByStart.set(record.start, record);
	}
	for (const declaration of declarations) {
		if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
			continue;
		const validation = validationByStart.get(
			declaration.initializer.getStart(source.sourceFile),
		);
		if (validation)
			validatedSources.set(declaration.name.text, validation.source);
	}
	for (let round = 0; round < declarations.length + 4; round += 1) {
		const before = descriptorSources.size + validatedSources.size + fields.size;
		for (const declaration of declarations) applyDeclaration(declaration);
		const after = descriptorSources.size + validatedSources.size + fields.size;
		if (before === after) break;
	}
	for (const [name, field] of fields) {
		if (invalidNames.has(name) || invalidSources.has(field.source))
			fields.delete(name);
	}
	const trustedFdBindings = new Set<string>();
	const trustedDigestBindings = new Set<string>();
	for (const [name, field] of fields) {
		if (field.kind === "fd") trustedFdBindings.add(name);
		else trustedDigestBindings.add(name);
	}
	const validations = [...validationByStart.values()];
	const isValidatedFdExpression = (
		expression: ts.Expression | undefined,
		useNode: ts.Node,
	): boolean => {
		const field = fieldForExpression(expression);
		if (!field || field.kind !== "fd") return false;
		const owner = functionOwner(useNode);
		return validations.some(
			(validation) =>
				validation.source === field.source &&
				validation.start < useNode.getStart(source.sourceFile) &&
				validation.owner === owner,
		);
	};
	return {
		trustedFdBindings,
		trustedDigestBindings,
		validatedBindings,
		strictAuthority: authorityByStart.size > 0,
		validatedPair: validations.length > 0,
		isValidatedFdExpression,
	};
}

function isAllowedLoaderRequest(
	node: ts.Expression,
	proof: LoaderProof,
	useNode: ts.Node,
): boolean {
	if (ts.isTemplateExpression(node)) {
		if (node.head.text !== "/dev/fd/") return false;
		if (node.templateSpans.length !== 1) return false;
		const span = node.templateSpans[0];
		if (!span || span.literal.text !== "") return false;
		return proof.isValidatedFdExpression(span.expression, useNode);
	}
	return false;
}

function sourceAllowsLoaderException(source: SourceRecord): boolean {
	return source.relativePath === packageLoaderSource;
}

function sourceHasDirectCreateRequireImport(source: SourceRecord): boolean {
	let found = false;
	for (const statement of source.sourceFile.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		const specifier = moduleSpecifierText(statement.moduleSpecifier);
		if (canonicalBuiltinSpecifier(specifier ?? "") !== "node:module") continue;
		if (!statement.importClause || statement.importClause.isTypeOnly) continue;
		const bindings = statement.importClause?.namedBindings;
		if (bindings && ts.isNamespaceImport(bindings)) {
			continue;
		}
		if (bindings && ts.isNamedImports(bindings)) {
			if (
				bindings.elements.some(
					(element) =>
						!element.isTypeOnly &&
						(element.propertyName?.text ?? element.name.text) ===
							"createRequire",
				)
			) {
				found = true;
				break;
			}
		}
	}
	if (found) return true;
	const aliases = collectModuleCallAliases(source.sourceFile);
	function visit(node: ts.Node): void {
		if (found) return;
		if (
			ts.isCallExpression(node) &&
			isCreateRequireCallForAliases(node, aliases)
		) {
			found = true;
			return;
		}
		ts.forEachChild(node, visit);
	}
	visit(source.sourceFile);
	return found;
}

function collectSupervisorAuthorityBindings(
	state: MutableAuditState,
	source: SourceRecord,
): Set<string> {
	const bindings = new Set<string>();
	for (const statement of source.sourceFile.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		const specifier = moduleSpecifierText(statement.moduleSpecifier);
		if (!specifier) continue;
		const target = resolveTarget(
			state.repoRoot,
			source.absolutePath,
			specifier,
		);
		const targetPath = target?.absoluteTarget
			? repoRelative(state.repoRoot, target.absoluteTarget)
			: undefined;
		if (
			targetPath !== "tools/compare/supervisor-client.ts" &&
			targetPath !== "tools/compare/supervisor-protocol.ts"
		)
			continue;
		const clause = statement.importClause;
		if (!clause || clause.isTypeOnly) continue;
		if (clause.name) bindings.add(clause.name.text);
		const namedBindings = clause.namedBindings;
		if (!namedBindings) continue;
		if (ts.isNamespaceImport(namedBindings)) {
			bindings.add(namedBindings.name.text);
			continue;
		}
		for (const element of namedBindings.elements) {
			if (element.isTypeOnly) continue;
			const imported = element.propertyName?.text ?? element.name.text;
			if (
				imported === "comparisonSupervisor" ||
				imported === "supervisorAuthority" ||
				imported === "supervisor"
			) {
				bindings.add(element.name.text);
			}
		}
	}
	for (let round = 0; round < 8; round += 1) {
		let changed = false;
		function visit(node: ts.Node): void {
			if (
				ts.isVariableDeclaration(node) &&
				ts.isIdentifier(node.name) &&
				node.initializer &&
				ts.isVariableDeclarationList(node.parent) &&
				(node.parent.flags & ts.NodeFlags.Const) !== 0 &&
				ts.isIdentifier(node.initializer) &&
				bindings.has(node.initializer.text) &&
				!bindings.has(node.name.text)
			) {
				bindings.add(node.name.text);
				changed = true;
			}
			if (
				ts.isVariableDeclaration(node) &&
				ts.isIdentifier(node.name) &&
				node.initializer &&
				ts.isVariableDeclarationList(node.parent) &&
				(node.parent.flags & ts.NodeFlags.Const) !== 0 &&
				(ts.isPropertyAccessExpression(node.initializer) ||
					ts.isElementAccessExpression(node.initializer)) &&
				ts.isIdentifier(node.initializer.expression) &&
				bindings.has(node.initializer.expression.text) &&
				["comparisonSupervisor", "supervisorAuthority", "supervisor"].includes(
					getStringProperty(node.initializer) ?? "",
				) &&
				!bindings.has(node.name.text)
			) {
				bindings.add(node.name.text);
				changed = true;
			}
			if (
				ts.isVariableDeclaration(node) &&
				node.name.kind !== ts.SyntaxKind.Identifier &&
				node.initializer &&
				ts.isVariableDeclarationList(node.parent) &&
				(node.parent.flags & ts.NodeFlags.Const) !== 0 &&
				ts.isIdentifier(node.initializer) &&
				bindings.has(node.initializer.text)
			) {
				for (const binding of bindingNames(node.name)) {
					if (
						[
							"comparisonSupervisor",
							"supervisorAuthority",
							"supervisor",
						].includes(binding.property ?? "") &&
						!bindings.has(binding.name)
					) {
						bindings.add(binding.name);
						changed = true;
					}
				}
			}
			ts.forEachChild(node, visit);
		}
		visit(source.sourceFile);
		if (!changed) break;
	}
	const written = new Set<string>();
	function collectWrites(node: ts.Node): void {
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken
		) {
			for (const name of assignmentTargetNames(node.left as ts.Expression))
				written.add(name);
		}
		if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
			if (
				node.operator === ts.SyntaxKind.PlusPlusToken ||
				node.operator === ts.SyntaxKind.MinusMinusToken
			) {
				for (const name of assignmentTargetNames(node.operand))
					written.add(name);
			}
		}
		ts.forEachChild(node, collectWrites);
	}
	collectWrites(source.sourceFile);
	for (const name of written) bindings.delete(name);
	return bindings;
}

function isCalleeReference(node: ts.Identifier): boolean {
	let parent = node.parent;
	while (
		ts.isParenthesizedExpression(parent) ||
		ts.isAsExpression(parent) ||
		ts.isTypeAssertionExpression(parent) ||
		ts.isNonNullExpression(parent)
	) {
		parent = parent.parent;
	}
	return (
		(ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
		parent.expression.getText() === node.getText()
	);
}

function reportForbidden(
	state: MutableAuditState,
	source: SourceRecord,
	node: ts.Node,
	name: string,
	message = `forbidden official-I/O surface '${name}'`,
): void {
	const endsWithName = (suffix: string): boolean =>
		name === suffix || name.endsWith(`.${suffix}`);
	const code =
		name === "import()"
			? "FORBIDDEN_DYNAMIC_IMPORT"
			: endsWithName("measureCellArm")
				? "FORBIDDEN_SYNTHETIC_EXECUTOR"
				: endsWithName("readdir") ||
						endsWithName("readdirSync") ||
						endsWithName("glob") ||
						endsWithName("globSync")
					? "FORBIDDEN_DIRECTORY_ENUMERATION"
					: endsWithName("process.env") ||
							endsWithName("process.cwd") ||
							endsWithName("process.argv") ||
							endsWithName("process.getBuiltinModule") ||
							name === "import.meta.resolve"
						? "FORBIDDEN_AMBIENT_AUTHORITY"
						: name === "network" || endsWithName("fetch")
							? "FORBIDDEN_NETWORK_ACCESS"
							: name === "import.meta.main"
								? "FORBIDDEN_ENTRYPOINT_WRAPPER"
								: name === "addon-loader" ||
										name === ".node" ||
										name.includes("dlopen")
									? "FORBIDDEN_ADDON_LOADER"
									: "FORBIDDEN_OFFICIAL_IO";
	reportNode(state, source, node, code, message);
}

function allowsPackageModuleException(
	source: SourceRecord,
	specifier: string,
	typeOnly = false,
): boolean {
	return (
		!typeOnly &&
		canonicalBuiltinSpecifier(specifier) === "node:module" &&
		sourceAllowsLoaderException(source) &&
		sourceHasDirectCreateRequireImport(source)
	);
}

function inspectModuleSpecifier(
	state: MutableAuditState,
	source: SourceRecord,
	node: ts.Node,
	specifier: string,
	typeOnly = false,
): void {
	if (
		isForbiddenBuiltinSpecifier(specifier) ||
		NETWORK_MODULES.has(specifier)
	) {
		if (!allowsPackageModuleException(source, specifier, typeOnly)) {
			reportNode(
				state,
				source,
				node,
				"FORBIDDEN_IMPORT",
				`forbidden module import '${specifier}'`,
			);
		}
	}
	if (specifier.endsWith(".node") || specifier.includes("/ffi")) {
		reportForbidden(state, source, node, "addon-loader");
	}
	if (specifier.startsWith("file:")) {
		reportForbidden(state, source, node, "fetch(file:...)");
	}
}

function inspectModuleImports(
	state: MutableAuditState,
	source: SourceRecord,
	node: ts.ImportDeclaration,
): void {
	const specifier = moduleSpecifierText(node.moduleSpecifier);
	if (!specifier) return;
	inspectModuleSpecifier(
		state,
		source,
		node.moduleSpecifier,
		specifier,
		isTypeOnlyImport(node),
	);
}

interface RustToken {
	readonly text: string;
	readonly kind: "identifier" | "string" | "punctuation";
	readonly line: number;
	readonly column: number;
}

function tokenizeRust(text: string): RustToken[] {
	const tokens: RustToken[] = [];
	let index = 0;
	let line = 1;
	let column = 1;
	const advance = (value: string): void => {
		for (const character of value) {
			if (character === "\n") {
				line += 1;
				column = 1;
			} else {
				column += 1;
			}
		}
		index += value.length;
	};
	while (index < text.length) {
		const startLine = line;
		const startColumn = column;
		const character = text[index] ?? "";
		if (/\s/.test(character)) {
			advance(character);
			continue;
		}
		if (text.startsWith("//", index)) {
			const end = text.indexOf("\n", index);
			advance(text.slice(index, end < 0 ? text.length : end));
			continue;
		}
		if (text.startsWith("/*", index)) {
			const end = text.indexOf("*/", index + 2);
			const value = text.slice(index, end < 0 ? text.length : end + 2);
			advance(value);
			continue;
		}
		// Rust lifetimes use a leading apostrophe but are not character
		// literals.  Keep the lifetime identifier visible so an impl header such
		// as `impl<'a> SecureFsSyscalls for LibcSyscalls` remains structurally
		// scoped instead of swallowing the header as one string token.
		if (
			character === "'" &&
			/[A-Za-z_]/.test(text[index + 1] ?? "") &&
			text[index + 2] !== "'"
		) {
			tokens.push({
				text: "'",
				kind: "punctuation",
				line: startLine,
				column: startColumn,
			});
			advance(character);
			continue;
		}
		if (character === '"' || character === "'") {
			const quote = character;
			let end = index + 1;
			while (end < text.length) {
				if (text[end] === "\\") {
					end += 2;
					continue;
				}
				if (text[end] === quote) {
					end += 1;
					break;
				}
				end += 1;
			}
			const value = text.slice(index, end);
			tokens.push({
				text: value.slice(1, value.endsWith(quote) ? -1 : undefined),
				kind: "string",
				line: startLine,
				column: startColumn,
			});
			advance(value);
			continue;
		}
		if (/[A-Za-z_]/.test(character)) {
			let end = index + 1;
			while (end < text.length && /[A-Za-z0-9_]/.test(text[end] ?? ""))
				end += 1;
			const value = text.slice(index, end);
			tokens.push({
				text: value,
				kind: "identifier",
				line: startLine,
				column: startColumn,
			});
			advance(value);
			continue;
		}
		const two = text.slice(index, index + 2);
		const punctuation = ["::", "=>", "->", "..", "&&", "||", "==", "!="];
		const value = punctuation.includes(two) ? two : character;
		tokens.push({
			text: value,
			kind: "punctuation",
			line: startLine,
			column: startColumn,
		});
		advance(value);
	}
	return tokens;
}

interface RustUseBinding {
	readonly path: readonly string[];
	readonly alias: string;
}

function parseRustUseBindings(tokens: readonly RustToken[]): RustUseBinding[] {
	const result: RustUseBinding[] = [];
	let index = 0;
	const emit = (path: readonly string[], alias: string): void => {
		if (path.length > 0) result.push({ path: [...path], alias });
	};
	function parseSequence(prefix: readonly string[], closeBrace: boolean): void {
		while (index < tokens.length) {
			const token = tokens[index];
			if (!token) return;
			if (token.text === "}") {
				index += 1;
				return;
			}
			if (token.text === ",") {
				index += 1;
				continue;
			}
			parsePath(prefix);
		}
		if (closeBrace) return;
	}
	function parsePath(prefix: readonly string[]): void {
		const segments = [...prefix];
		while (index < tokens.length) {
			const token = tokens[index];
			if (!token || token.kind !== "identifier") {
				if (token) index += 1;
				return;
			}
			index += 1;
			if (token.text === "self") {
				let alias = segments.at(-1) ?? "self";
				if (tokens[index]?.text === "as") {
					index += 1;
					const aliasToken = tokens[index];
					if (aliasToken?.kind === "identifier") {
						alias = aliasToken.text;
						index += 1;
					}
				}
				emit(segments, alias);
				return;
			}
			if (token.text === "as") {
				const aliasToken = tokens[index];
				if (aliasToken?.kind === "identifier") {
					emit(segments, aliasToken.text);
					index += 1;
				}
				return;
			}
			segments.push(token.text);
			if (tokens[index]?.text === "::") {
				index += 1;
				if (tokens[index]?.text === "{") {
					index += 1;
					parseSequence(segments, true);
					return;
				}
				continue;
			}
			if (tokens[index]?.text === "{") {
				index += 1;
				parseSequence(segments, true);
				return;
			}
			if (tokens[index]?.text === "as") {
				index += 1;
				const aliasToken = tokens[index];
				if (aliasToken?.kind === "identifier") {
					emit(segments, aliasToken.text);
					index += 1;
				}
				return;
			}
			emit(segments, segments.at(-1) ?? token.text);
			return;
		}
	}
	parseSequence([], false);
	return result;
}

function inspectRustSource(
	state: MutableAuditState,
	relativePath: string,
): void {
	const absolutePath = resolve(state.repoRoot, relativePath);
	if (!isWithin(state.repoRoot, absolutePath)) {
		reportFile(
			state,
			relativePath,
			"NATIVE_PATH_INVALID",
			"native source path escapes the repository root",
		);
		return;
	}
	if (!existsSync(absolutePath)) {
		reportFile(
			state,
			relativePath,
			"EXPECTED_NATIVE_SOURCE_MISSING",
			"allowlisted native source is missing",
		);
		return;
	}
	try {
		if (resolve(realpathSync(absolutePath)) !== absolutePath) {
			reportFile(
				state,
				relativePath,
				"NATIVE_PATH_INVALID",
				"allowlisted native source is a symbolic-link alias",
			);
			return;
		}
	} catch {
		reportFile(
			state,
			relativePath,
			"SOURCE_REALPATH_FAILED",
			"cannot establish native source identity",
		);
		return;
	}
	let text: string;
	try {
		text = readFileSync(absolutePath, "utf8");
	} catch {
		reportFile(
			state,
			relativePath,
			"SOURCE_READ_FAILED",
			"cannot read allowlisted native source",
		);
		return;
	}
	const tokens = tokenizeRust(text);
	const pathAliases = new Set<string>();
	const fsAliases = new Set<string>();
	const fsModuleAliases = new Set<string>();
	const processModuleAliases = new Set<string>();
	const commandAliases = new Set<string>();
	const scopes: Array<{ readonly labels: ReadonlySet<string> }> = [];
	const sealedFs = new Set([
		"SecureFsSyscalls",
		"LibcSyscalls",
		"SupervisorObservationSyscalls",
	]);
	const sealedCommands = new Set(["SupervisorCommandRunner"]);
	const pathMethods = new Set([
		"open",
		"create",
		"new",
		"from",
		"join",
		"push",
		"pop",
		"set_file_name",
		"set_extension",
		"components",
		"parent",
		"file_name",
		"canonicalize",
		"read_link",
		"symlink_metadata",
		"metadata",
		"read",
		"read_to_string",
		"read_dir",
		"write",
		"remove_file",
		"remove_dir",
		"create_dir",
		"create_dir_all",
		"copy",
		"rename",
	]);
	const fsFunctions = new Set([
		"read",
		"read_to_string",
		"read_dir",
		"write",
		"metadata",
		"symlink_metadata",
		"canonicalize",
		"read_link",
		"remove_file",
		"remove_dir",
		"create_dir",
		"create_dir_all",
		"copy",
		"rename",
	]);
	const reportToken = (
		token: RustToken,
		code: "NATIVE_PATH_IO_FORBIDDEN" | "NATIVE_COMMAND_FORBIDDEN",
		message: string,
	): void =>
		addFailure(state, {
			code,
			file: relativePath,
			line: token.line,
			column: token.column,
			message,
		});
	const currentLabels = (): Set<string> => {
		const result = new Set<string>();
		for (const scope of scopes)
			for (const label of scope.labels) result.add(label);
		return result;
	};
	const allowedFsScope = (): boolean => {
		const labels = currentLabels();
		return [...sealedFs].some((label) => labels.has(label));
	};
	const allowedCommandScope = (): boolean => {
		const labels = currentLabels();
		return [...sealedCommands].some((label) => labels.has(label));
	};
	const labelsForImpl = (openBraceIndex: number): Set<string> => {
		const labels = new Set<string>();
		let implIndex = -1;
		for (
			let look = openBraceIndex - 1;
			look >= 0 && openBraceIndex - look < 120;
			look -= 1
		) {
			const candidate = tokens[look];
			if (!candidate || candidate.text === ";" || candidate.text === "}") break;
			if (candidate.text === "impl") {
				implIndex = look;
				break;
			}
		}
		if (implIndex < 0) return labels;
		let angleDepth = 0;
		for (let index = implIndex + 1; index < openBraceIndex; index += 1) {
			const token = tokens[index];
			if (!token) continue;
			if (token.text === "where") break;
			if (token.text === "<") {
				angleDepth += 1;
				continue;
			}
			if (token.text === ">") {
				angleDepth = Math.max(0, angleDepth - 1);
				continue;
			}
			if (
				angleDepth === 0 &&
				token.kind === "identifier" &&
				(sealedFs.has(token.text) || sealedCommands.has(token.text))
			) {
				labels.add(token.text);
			}
		}
		return labels;
	};

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token) continue;
		const previous = tokens[index - 1];
		const inUseDeclaration =
			previous?.text === "use" ||
			(previous?.text !== ";" &&
				previous?.text !== "{" &&
				previous?.text !== "}" &&
				index > 0 &&
				tokens
					.slice(Math.max(0, index - 24), index)
					.some((item) => item.text === "use") &&
				!tokens
					.slice(Math.max(0, index - 24), index)
					.some((item) => item.text === ";"));
		if (token.text === "use") {
			let end = index + 1;
			while (end < tokens.length && tokens[end]?.text !== ";") end += 1;
			const useTokens = tokens.slice(index + 1, end);
			for (const binding of parseRustUseBindings(useTokens)) {
				const path = binding.path.join("::");
				const leaf = binding.path.at(-1);
				if (path === "std::fs" || path.startsWith("std::fs::")) {
					if (path === "std::fs" || leaf === "self") {
						fsAliases.add(binding.alias);
						fsModuleAliases.add(binding.alias);
					} else if (leaf && fsFunctions.has(leaf)) {
						fsAliases.add(binding.alias);
					}
					// File/OpenOptions aliases (including nested groups), and
					// aliases for the `std::fs` module itself, expose path-like
					// methods such as File::open and fs::read_to_string.
					pathAliases.add(binding.alias);
				}
				if (path === "std::path" || path.startsWith("std::path::")) {
					pathAliases.add(binding.alias);
				}
				if (path === "std::process::Command") {
					commandAliases.add(binding.alias);
				}
				if (
					path === "std::process" ||
					(leaf === "self" && path === "std::process")
				) {
					processModuleAliases.add(binding.alias);
				}
			}
		}
		if (
			token.text === "type" &&
			tokens[index + 1]?.kind === "identifier" &&
			tokens[index + 2]?.text === "="
		) {
			const alias = tokens[index + 1]?.text;
			const rhs: string[] = [];
			for (let look = index + 3; look < tokens.length; look += 1) {
				const rhsToken = tokens[look];
				if (!rhsToken || rhsToken.text === ";") break;
				if (rhsToken.kind === "identifier") rhs.push(rhsToken.text);
			}
			if (alias && rhs.length > 0) {
				const fsType = rhs[0] === "std" && rhs[1] === "fs";
				const pathType = rhs[0] === "std" && rhs[1] === "path";
				const processType =
					rhs[0] === "std" && rhs[1] === "process" && rhs[2] === "Command";
				if (
					fsType ||
					pathType ||
					fsModuleAliases.has(rhs[0] ?? "") ||
					pathAliases.has(rhs[0] ?? "")
				)
					pathAliases.add(alias);
				if (processType || processModuleAliases.has(rhs[0] ?? ""))
					commandAliases.add(alias);
			}
		}
		if (token.text === "{") {
			const labels = labelsForImpl(index);
			scopes.push({ labels });
			continue;
		}
		if (token.text === "}") {
			scopes.pop();
			continue;
		}
		if (token.kind === "string") {
			if (/^(?:sh|bash|zsh)$/.test(token.text)) {
				const next = tokens[index + 1];
				if (
					next?.kind === "string" &&
					next.text === "-c" &&
					!allowedCommandScope()
				) {
					reportToken(
						token,
						"NATIVE_COMMAND_FORBIDDEN",
						"shell execution is outside the sealed supervisor command runner",
					);
				}
			}
			continue;
		}
		if (inUseDeclaration) {
			if (token.text === ";") continue;
			continue;
		}
		if (token.text === ";") continue;
		if (token.text === "std") {
			const path =
				tokens[index + 1]?.text === "::" ? tokens[index + 2]?.text : undefined;
			const leaf =
				tokens[index + 3]?.text === "::" ? tokens[index + 4]?.text : undefined;
			if (path === "fs" || path === "path") {
				if (!allowedFsScope()) {
					reportToken(
						token,
						"NATIVE_PATH_IO_FORBIDDEN",
						"direct native filesystem/path access is outside the sealed syscall implementation",
					);
				}
			}
			if (path === "process" && leaf === "Command" && !allowedCommandScope()) {
				reportToken(
					token,
					"NATIVE_COMMAND_FORBIDDEN",
					"arbitrary native command use is outside the sealed command runner",
				);
			}
		}
		if (token.kind !== "identifier") continue;
		const next = tokens[index + 1];
		const afterNext = tokens[index + 2];
		if (fsAliases.has(token.text) && next?.text === "(" && !allowedFsScope()) {
			reportToken(
				token,
				"NATIVE_PATH_IO_FORBIDDEN",
				"aliased native filesystem access is outside the sealed syscall implementation",
			);
		}
		if (
			fsAliases.has(token.text) &&
			next?.text === "::" &&
			afterNext?.kind === "identifier" &&
			fsFunctions.has(afterNext.text) &&
			!allowedFsScope()
		) {
			reportToken(
				token,
				"NATIVE_PATH_IO_FORBIDDEN",
				"aliased native filesystem access is outside the sealed syscall implementation",
			);
		}
		if (
			(fsModuleAliases.has(token.text) || pathAliases.has(token.text)) &&
			next?.text === "::" &&
			afterNext?.kind === "identifier" &&
			["File", "OpenOptions", "Path", "PathBuf"].includes(afterNext.text) &&
			tokens[index + 3]?.text === "::" &&
			pathMethods.has(tokens[index + 4]?.text ?? "") &&
			!allowedFsScope()
		) {
			reportToken(
				token,
				"NATIVE_PATH_IO_FORBIDDEN",
				"aliased native filesystem/path access is outside the sealed syscall implementation",
			);
		}
		if (
			processModuleAliases.has(token.text) &&
			next?.text === "::" &&
			afterNext?.text === "Command" &&
			tokens[index + 3]?.text === "::" &&
			tokens[index + 4]?.text === "new" &&
			!allowedCommandScope()
		) {
			reportToken(
				token,
				"NATIVE_COMMAND_FORBIDDEN",
				"aliased native command use is outside the sealed command runner",
			);
		}
		if (next?.text !== "::" || afterNext?.kind !== "identifier") continue;
		if (
			(pathAliases.has(token.text) ||
				["File", "OpenOptions", "Path", "PathBuf"].includes(token.text)) &&
			pathMethods.has(afterNext.text) &&
			!allowedFsScope()
		) {
			reportToken(
				token,
				"NATIVE_PATH_IO_FORBIDDEN",
				"aliased native filesystem/path access is outside the sealed syscall implementation",
			);
		}
		if (
			(commandAliases.has(token.text) || token.text === "Command") &&
			afterNext.text === "new" &&
			!allowedCommandScope()
		) {
			reportToken(
				token,
				"NATIVE_COMMAND_FORBIDDEN",
				"arbitrary native command use is outside the sealed command runner",
			);
		}
	}
}

function staticImportTypeOnly(node: ts.ExportDeclaration): boolean {
	if (node.isTypeOnly) return true;
	if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return false;
	return (
		node.exportClause.elements.length > 0 &&
		node.exportClause.elements.every((element) => element.isTypeOnly)
	);
}

function visitStaticEdges(
	state: MutableAuditState,
	source: SourceRecord,
	queue: SourceRecord[],
	node: ts.Node,
	recordEdges = true,
): void {
	if (ts.isImportDeclaration(node)) {
		const specifier = moduleSpecifierText(node.moduleSpecifier);
		if (!specifier) return;
		const target = addResolvedEdge(
			state,
			source,
			specifier,
			isTypeOnlyImport(node),
			node.moduleSpecifier,
			recordEdges,
		);
		inspectModuleImports(state, source, node);
		if (
			target?.absoluteTarget &&
			isWithin(state.repoRoot, target.absoluteTarget)
		) {
			const child = parseSource(state, target.absoluteTarget);
			if (child) queue.push(child);
		}
		return;
	}
	if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
		const specifier = moduleSpecifierText(node.moduleSpecifier);
		if (!specifier) return;
		const target = addResolvedEdge(
			state,
			source,
			specifier,
			staticImportTypeOnly(node),
			node.moduleSpecifier,
			recordEdges,
		);
		inspectModuleSpecifier(
			state,
			source,
			node.moduleSpecifier,
			specifier,
			staticImportTypeOnly(node),
		);
		if (
			target?.absoluteTarget &&
			isWithin(state.repoRoot, target.absoluteTarget)
		) {
			const child = parseSource(state, target.absoluteTarget);
			if (child) queue.push(child);
		}
		return;
	}
	if (ts.isImportEqualsDeclaration(node)) {
		const reference = node.moduleReference;
		if (ts.isExternalModuleReference(reference) && reference.expression) {
			const specifier = literalText(reference.expression);
			if (specifier) {
				const target = addResolvedEdge(
					state,
					source,
					specifier,
					false,
					reference.expression,
					recordEdges,
				);
				inspectModuleSpecifier(state, source, reference.expression, specifier);
				if (
					target?.absoluteTarget &&
					isWithin(state.repoRoot, target.absoluteTarget)
				) {
					const child = parseSource(state, target.absoluteTarget);
					if (child) queue.push(child);
				}
			}
			reportForbidden(state, source, node, "require");
		} else {
			reportForbidden(
				state,
				source,
				node,
				"require",
				"import= aliases must use a statically reviewable external module reference",
			);
		}
		return;
	}
	if (ts.isImportTypeNode(node)) {
		const argument = node.argument;
		if (ts.isLiteralTypeNode(argument)) {
			const specifier = literalText(argument.literal);
			if (specifier) {
				const target = addResolvedEdge(
					state,
					source,
					specifier,
					true,
					node,
					recordEdges,
				);
				inspectModuleSpecifier(state, source, node, specifier, true);
				if (
					target?.absoluteTarget &&
					isWithin(state.repoRoot, target.absoluteTarget)
				) {
					const child = parseSource(state, target.absoluteTarget);
					if (child) queue.push(child);
				}
			} else {
				reportNode(
					state,
					source,
					node,
					"UNRESOLVED_STATIC_IMPORT",
					"type import must use a literal module specifier",
				);
			}
		} else {
			reportNode(
				state,
				source,
				node,
				"UNRESOLVED_STATIC_IMPORT",
				"type import must use a literal module specifier",
			);
		}
		return;
	}
	ts.forEachChild(node, (child) =>
		visitStaticEdges(state, source, queue, child, recordEdges),
	);
}

function collectGraph(
	state: MutableAuditState,
	rootPaths: readonly string[],
): void {
	const queue: SourceRecord[] = [];
	for (const root of rootPaths) {
		const absolutePath = resolve(state.repoRoot, TOOLS_COMPARE_ROOT, root);
		if (!existsSync(absolutePath)) {
			reportFile(
				state,
				`${TOOLS_COMPARE_ROOT}/${root}`,
				"OFFICIAL_ROOT_MISSING",
				"allowlisted official entrypoint is missing",
			);
			continue;
		}
		const source = parseSource(state, absolutePath);
		if (source) queue.push(source);
	}

	while (queue.length > 0) {
		const source = queue.shift();
		if (!source || state.visited.has(source.relativePath)) continue;
		state.visited.add(source.relativePath);
		visitStaticEdges(state, source, queue, source.sourceFile);
	}

	// Module export identities need the complete source graph.  Recompute a
	// small fixed point so aliases crossing re-export boundaries are resolved.
	for (const source of state.sourceByPath.values()) {
		if (state.visited.has(source.relativePath)) {
			state.moduleAnalysis.set(source.relativePath, getModuleExports());
		}
	}
	for (let round = 0; round < 4; round += 1) {
		const exports = new Map<string, Map<string, Identity>>();
		for (const [relativePath, analysis] of state.moduleAnalysis) {
			exports.set(relativePath, analysis.exports);
		}
		for (const source of state.sourceByPath.values()) {
			if (!state.visited.has(source.relativePath)) continue;
			const next = collectLocalIdentities(state, source, exports);
			state.moduleAnalysis.set(source.relativePath, next);
		}
	}
}

function collectLoaderGraph(
	state: MutableAuditState,
	root: SourceRecord,
): SourceRecord[] {
	const queue: SourceRecord[] = [root];
	const loaderSources: SourceRecord[] = [];
	const visited = new Set<string>();
	while (queue.length > 0) {
		const source = queue.shift();
		if (!source || visited.has(source.relativePath)) continue;
		visited.add(source.relativePath);
		loaderSources.push(source);
		// The package loader is outside the official child graph, so its edges
		// are audited and traversed but deliberately excluded from the frozen
		// official resolved-graph digest.
		visitStaticEdges(state, source, queue, source.sourceFile, false);
	}

	for (const source of loaderSources)
		state.moduleAnalysis.set(source.relativePath, getModuleExports());
	for (let round = 0; round < 4; round += 1) {
		const exports = new Map<string, Map<string, Identity>>();
		for (const [relativePath, analysis] of state.moduleAnalysis)
			exports.set(relativePath, analysis.exports);
		for (const source of loaderSources) {
			state.moduleAnalysis.set(
				source.relativePath,
				collectLocalIdentities(state, source, exports),
			);
		}
	}
	return loaderSources.sort((left, right) =>
		compareStrings(left.relativePath, right.relativePath),
	);
}

function calleeLabel(
	callee: ts.Expression,
	identities: Map<string, Identity>,
): string | undefined {
	const identity = identityForExpression(callee, identities);
	const name = identityName(identity);
	if (name) return name;
	if (ts.isIdentifier(callee)) return callee.text;
	return undefined;
}

function inspectSourceCalls(
	state: MutableAuditState,
	source: SourceRecord,
): void {
	const analysis = state.moduleAnalysis.get(source.relativePath);
	if (!analysis) return;
	const identities = analysis.localIdentities;
	const moduleCallAliases = collectModuleCallAliases(source.sourceFile);
	const loaderProof = sourceAllowsLoaderException(source)
		? collectLoaderProof(state, source)
		: {
				trustedFdBindings: new Set<string>(),
				trustedDigestBindings: new Set<string>(),
				validatedBindings: new Set<string>(),
				strictAuthority: false,
				validatedPair: false,
				isValidatedFdExpression: () => false,
			};
	let validLoaderCallCount = 0;
	let loaderCallCount = 0;
	let createRequireCallCount = 0;

	function isAllowedNodeModuleRequireSetup(node: ts.CallExpression): boolean {
		return (
			sourceAllowsLoaderException(source) &&
			nodeModuleRequireCall(
				node,
				moduleCallAliases.requireAliases,
				moduleCallAliases.moduleAliases,
			) &&
			sourceHasDirectCreateRequireImport(source)
		);
	}

	function loaderIsInFallbackContainer(node: ts.Node): boolean {
		let parent: ts.Node | undefined = node.parent;
		while (parent) {
			if (
				ts.isForStatement(parent) ||
				ts.isForInStatement(parent) ||
				ts.isForOfStatement(parent) ||
				ts.isWhileStatement(parent) ||
				ts.isDoStatement(parent) ||
				ts.isTryStatement(parent) ||
				ts.isArrayLiteralExpression(parent) ||
				ts.isConditionalExpression(parent) ||
				(ts.isBinaryExpression(parent) &&
					(parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
						parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
						parent.operatorToken.kind ===
							ts.SyntaxKind.AmpersandAmpersandToken ||
						parent.operatorToken.kind === ts.SyntaxKind.CommaToken))
			) {
				return true;
			}
			parent = parent.parent;
		}
		return false;
	}

	function inspectIdentity(node: ts.Node, identity: Identity): void {
		const name = identityName(identity);
		if (!name) return;
		const exact = FORBIDDEN_CALLS.has(name);
		const suffix = [...FORBIDDEN_CALLS].some((candidate) =>
			name.endsWith(`.${candidate}`),
		);
		const global = FORBIDDEN_GLOBAL_CALLS.has(name);
		const fsLike =
			name.startsWith("module:node:fs") ||
			name.startsWith("module:node:path") ||
			name.startsWith("module:node:child_process") ||
			name.startsWith("module:node:module") ||
			name.startsWith("module:bun:ffi") ||
			name.startsWith("module:node:ffi");
		if (exact || suffix || global || fsLike) {
			if (
				name === "module:node:module.createRequire" &&
				sourceAllowsLoaderException(source) &&
				sourceHasDirectCreateRequireImport(source) &&
				((ts.isCallExpression(node.parent) &&
					node.parent.expression === node &&
					node.parent.arguments.length === 1 &&
					isImportMetaUrl(node.parent.arguments[0])) ||
					isCreateRequireReferenceForAliases(
						node as ts.Expression,
						moduleCallAliases,
					))
			) {
				return;
			}
			reportForbidden(state, source, node, name);
		}
	}

	function visit(node: ts.Node): void {
		if (isImportMetaMain(node)) {
			reportForbidden(state, source, node, "import.meta.main");
		}
		if (isImportMetaResolve(node)) {
			reportForbidden(state, source, node, "import.meta.resolve");
		}
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			isAssignmentPattern(node.left)
		) {
			const assignedIdentity = identityForExpression(node.right, identities);
			if (identityName(assignedIdentity) === "import.meta") {
				for (const binding of assignmentPatternProperties(node.left)) {
					if (binding.computed || !binding.property) {
						reportForbidden(
							state,
							source,
							binding.node,
							"computed-property",
							"computed/destructured import.meta access is not statically reviewable",
						);
						continue;
					}
					if (binding.property === "main" || binding.property === "resolve") {
						reportForbidden(
							state,
							source,
							binding.node,
							`import.meta.${binding.property}`,
							`destructured assignment of import.meta.${binding.property} is forbidden`,
						);
					}
				}
			}
		}
		if (ts.isImportDeclaration(node)) {
			inspectModuleImports(state, source, node);
		}
		if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
			const specifier = moduleSpecifierText(node.moduleSpecifier);
			if (
				specifier &&
				(isForbiddenBuiltinSpecifier(specifier) ||
					NETWORK_MODULES.has(specifier))
			) {
				if (
					!(
						canonicalBuiltinSpecifier(specifier) === "node:module" &&
						sourceAllowsLoaderException(source) &&
						sourceHasDirectCreateRequireImport(source)
					)
				) {
					reportForbidden(
						state,
						source,
						node.moduleSpecifier,
						`module:${specifier}`,
					);
				}
			}
		}
		if (ts.isImportEqualsDeclaration(node)) {
			const reference = node.moduleReference;
			if (!ts.isExternalModuleReference(reference)) {
				reportForbidden(
					state,
					source,
					node,
					"require",
					"import= aliases must use a statically reviewable external module reference",
				);
			}
		}
		if (ts.isCallExpression(node)) {
			if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
				reportForbidden(state, source, node, "import()");
			}
			for (const argument of node.arguments) {
				if (isLoaderIdentity(identityForExpression(argument, identities))) {
					reportForbidden(state, source, argument, "addon-loader");
				}
			}
			const identity = identityForExpression(node.expression, identities);
			const label = calleeLabel(node.expression, identities);
			const importedCreateRequire =
				identityName(identity) === "module:node:module.createRequire" ||
				isCreateRequireCallForAliases(node, moduleCallAliases);
			const moduleRequireCall = isRequireCall(
				node,
				moduleCallAliases.requireAliases,
				moduleCallAliases.moduleAliases,
			);
			if (importedCreateRequire) {
				createRequireCallCount += 1;
				if (
					!sourceAllowsLoaderException(source) ||
					!sourceHasDirectCreateRequireImport(source) ||
					node.arguments.length !== 1 ||
					!isImportMetaUrl(node.arguments[0])
				) {
					reportForbidden(state, source, node, "createRequire");
				}
			} else if (moduleRequireCall) {
				if (!isAllowedNodeModuleRequireSetup(node)) {
					reportForbidden(state, source, node, label ?? "require");
				}
			} else if (isLoaderIdentity(identity)) {
				loaderCallCount += 1;
				if (loaderIsInFallbackContainer(node)) {
					reportForbidden(
						state,
						source,
						node,
						"addon-loader",
						"package loader must perform one direct attempt with zero fallback containers",
					);
				}
				const loaderRequest =
					node.arguments.length === 1 ? node.arguments[0] : undefined;
				const validLoaderCall =
					sourceAllowsLoaderException(source) &&
					sourceHasDirectCreateRequireImport(source) &&
					loaderProof.strictAuthority &&
					loaderProof.validatedPair &&
					loaderProof.trustedFdBindings.size > 0 &&
					loaderRequest !== undefined &&
					isAllowedLoaderRequest(loaderRequest, loaderProof, node);
				if (!validLoaderCall) {
					reportForbidden(state, source, node, "addon-loader");
				} else {
					validLoaderCallCount += 1;
				}
			} else if (label) {
				inspectIdentity(node.expression, identity ?? label);
				if (label === "fetch" || label.endsWith(".fetch")) {
					reportForbidden(state, source, node, "network");
				}
				if (
					label === "require" ||
					label.endsWith(".require") ||
					label.endsWith(".createRequire")
				)
					if (!isAllowedNodeModuleRequireSetup(node))
						reportForbidden(state, source, node, label);
				if (
					label.endsWith(".dlopen") ||
					label.endsWith(".spawn") ||
					label.endsWith(".spawnSync") ||
					label.endsWith(".file") ||
					label.endsWith(".write")
				) {
					reportForbidden(state, source, node, label);
				}
			}
			if (label && FORBIDDEN_GLOBAL_CALLS.has(label)) {
				inspectIdentity(node.expression, label);
			}
		}
		if (ts.isNewExpression(node)) {
			const identity = identityForExpression(node.expression, identities);
			const label = calleeLabel(node.expression, identities);
			if (label) inspectIdentity(node.expression, identity ?? label);
		}
		if (
			ts.isPropertyAccessExpression(node) ||
			ts.isElementAccessExpression(node)
		) {
			const identity = identityForExpression(node, identities);
			if (identity) inspectIdentity(node, identity);
			const base = identityForExpression(node.expression, identities);
			const property = getStringProperty(node);
			if (
				property === undefined &&
				(base === "Bun" ||
					base === "Deno" ||
					base === "process" ||
					base === "module" ||
					isAmbientNamespaceIdentity(base))
			) {
				reportForbidden(state, source, node, "computed-property");
			}
			if (isLoaderIdentity(base)) {
				reportForbidden(state, source, node, "addon-loader");
			}
		}
		if (ts.isIdentifier(node) && FORBIDDEN_GLOBAL_CALLS.has(node.text)) {
			const parent = node.parent;
			// This bare-name rule exists to catch alias spellings of the
			// enumerated forbidden functions (`const c = close`). Declaration
			// NAMES — methods, properties, signatures, bindings, parameters,
			// object-literal members — merely reuse the word and declare
			// product API surface, not a reference to a forbidden function.
			const isDeclarationName =
				(ts.isMethodDeclaration(parent) && parent.name === node) ||
				(ts.isMethodSignature(parent) && parent.name === node) ||
				(ts.isPropertyDeclaration(parent) && parent.name === node) ||
				(ts.isPropertySignature(parent) && parent.name === node) ||
				(ts.isPropertyAssignment(parent) && parent.name === node) ||
				(ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
				(ts.isSetAccessorDeclaration(parent) && parent.name === node) ||
				(ts.isVariableDeclaration(parent) && parent.name === node) ||
				(ts.isBindingElement(parent) && parent.name === node) ||
				(ts.isParameter(parent) && parent.name === node) ||
				(ts.isFunctionDeclaration(parent) && parent.name === node) ||
				(ts.isEnumMember(parent) && parent.name === node);
			if (
				!ts.isCallExpression(parent) &&
				!ts.isPropertyAccessExpression(parent) &&
				!isDeclarationName
			) {
				reportForbidden(state, source, node, node.text);
			}
		}
		if (ts.isIdentifier(node)) {
			const localIdentity = identities.get(node.text);
			const parent = node.parent;
			const isBindingName =
				(ts.isVariableDeclaration(parent) && parent.name === node) ||
				(ts.isBindingElement(parent) && parent.name === node) ||
				(ts.isParameter(parent) && parent.name === node) ||
				(ts.isImportSpecifier(parent) && parent.name === node) ||
				(ts.isImportClause(parent) && parent.name === node) ||
				(ts.isNamespaceImport(parent) && parent.name === node);
			const isPropertyName =
				(ts.isPropertyAccessExpression(parent) && parent.name === node) ||
				(ts.isPropertyDeclaration(parent) && parent.name === node) ||
				(ts.isMethodDeclaration(parent) && parent.name === node) ||
				(ts.isPropertySignature(parent) && parent.name === node);
			if (localIdentity && !isBindingName && !isPropertyName) {
				inspectIdentity(node, localIdentity);
			}
		}
		if (
			ts.isIdentifier(node) &&
			["eval", "Function", "require"].includes(node.text)
		) {
			const parent = node.parent;
			const isCallCallee = isCalleeReference(node);
			const isNewCallee =
				ts.isNewExpression(parent) && parent.expression === node;
			if (
				!isCallCallee &&
				(!isNewCallee || node.text === "Function" || node.text === "require")
			) {
				reportForbidden(state, source, node, node.text);
			}
		}
		if (
			ts.isIdentifier(node) &&
			identityName(identities.get(node.text)) ===
				"module:node:module.createRequire"
		) {
			const parent = node.parent;
			const isCallCallee = isCalleeReference(node);
			const isImportBinding =
				ts.isImportSpecifier(parent) ||
				ts.isNamespaceImport(parent) ||
				ts.isImportClause(parent);
			if (!isCallCallee && !isImportBinding) {
				reportForbidden(state, source, node, "createRequire");
			}
		}
		if (ts.isIdentifier(node) && isLoaderIdentity(identities.get(node.text))) {
			const parent = node.parent;
			const isBindingName =
				(ts.isVariableDeclaration(parent) && parent.name === node) ||
				(ts.isBindingElement(parent) && parent.name === node);
			const isDirectCallCallee = isCalleeReference(node);
			if (!isBindingName && !isDirectCallCallee) {
				reportForbidden(state, source, node, "addon-loader");
			}
		}
		if (ts.isBindingElement(node)) {
			let declaration: ts.Node | undefined = node.parent;
			while (declaration && !ts.isVariableDeclaration(declaration)) {
				declaration = declaration.parent;
			}
			const initializerIdentity =
				declaration && ts.isVariableDeclaration(declaration)
					? identityForExpression(declaration.initializer, identities)
					: undefined;
			if (
				declaration &&
				ts.isVariableDeclaration(declaration) &&
				(identityName(initializerIdentity) === "import.meta" ||
					isAmbientNamespaceIdentity(initializerIdentity))
			) {
				if (node.dotDotDotToken) {
					reportForbidden(
						state,
						source,
						node.name,
						"computed-property",
						"rest destructuring of import.meta is forbidden",
					);
				}
				const property =
					propertyNameText(node.propertyName) ??
					(ts.isIdentifier(node.name) ? node.name.text : undefined);
				if (
					identityName(initializerIdentity) === "import.meta" &&
					(property === "main" || property === "resolve")
				) {
					reportForbidden(
						state,
						source,
						node.name,
						`import.meta.${property}`,
						`destructured import.meta.${property} is forbidden`,
					);
				}
				if (node.propertyName && ts.isComputedPropertyName(node.propertyName)) {
					reportForbidden(
						state,
						source,
						node.propertyName,
						"computed-property",
						"computed/destructured ambient module access is not statically reviewable",
					);
				}
			}
		}
		if (ts.isStringLiteral(node) && /\.node$/i.test(node.text)) {
			reportForbidden(state, source, node, ".node");
		}
		ts.forEachChild(node, visit);
	}

	visit(source.sourceFile);
	if (sourceAllowsLoaderException(source)) {
		if (!sourceHasDirectCreateRequireImport(source)) {
			reportForbidden(
				state,
				source,
				source.sourceFile,
				"addon-loader",
				"the sole package-loader exception requires a direct node:module createRequire authority",
			);
		}
		if (!loaderProof.strictAuthority) {
			reportForbidden(
				state,
				source,
				source.sourceFile,
				"addon-loader",
				"loader authority must be structurally bound to strict comparison-supervisor mode",
			);
		}
		if (!loaderProof.validatedPair) {
			reportForbidden(
				state,
				source,
				source.sourceFile,
				"addon-loader",
				"loader descriptor must carry validated pre-opened FD identity and digest dataflow",
			);
		}
		if (createRequireCallCount !== 1) {
			reportForbidden(
				state,
				source,
				source.sourceFile,
				"addon-loader",
				"package loader requires exactly one createRequire authority construction",
			);
		}
	}
	if (
		sourceAllowsLoaderException(source) &&
		(validLoaderCallCount !== 1 || loaderCallCount !== 1)
	) {
		reportForbidden(
			state,
			source,
			source.sourceFile,
			"addon-loader",
			"the sole package-loader exception requires exactly one descriptor attempt",
		);
	}
}

function isImportMetaUrl(node: ts.Expression | undefined): boolean {
	const expression = unwrapModuleExpression(node);
	return (
		!!expression &&
		ts.isPropertyAccessExpression(expression) &&
		ts.isMetaProperty(expression.expression) &&
		expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
		expression.expression.name.text === "meta" &&
		expression.name.text === "url"
	);
}

class InventoryScanError extends Error {
	readonly path: string;
	readonly reason: string;

	constructor(path: string, reason: string) {
		super(`${reason}: ${path}`);
		this.name = "InventoryScanError";
		this.path = path;
		this.reason = reason;
	}
}

function checkedInventoryPath(
	absolutePath: string,
	rootRealPath: string,
): { readonly isDirectory: boolean; readonly isFile: boolean } {
	let lstat: ReturnType<typeof lstatSync>;
	try {
		lstat = lstatSync(absolutePath);
	} catch {
		throw new InventoryScanError(absolutePath, "inventory lstat failed");
	}
	if (lstat.isSymbolicLink()) {
		throw new InventoryScanError(
			absolutePath,
			"inventory rejects symbolic-link aliases and escapes",
		);
	}
	let realPath: string;
	try {
		realPath = resolve(realpathSync(absolutePath));
	} catch {
		throw new InventoryScanError(absolutePath, "inventory realpath failed");
	}
	if (!isWithin(rootRealPath, realPath) || realPath !== resolve(absolutePath)) {
		throw new InventoryScanError(
			absolutePath,
			"inventory path is outside its realpath-contained root or has an alias",
		);
	}
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(absolutePath);
	} catch {
		throw new InventoryScanError(absolutePath, "inventory stat failed");
	}
	return { isDirectory: stat.isDirectory(), isFile: stat.isFile() };
}

function walkTypeScriptFiles(
	directory: string,
	output: string[] = [],
	includeTests = false,
	rootRealPath?: string,
): string[] {
	const ignoredDirectories = new Set([
		".git",
		".cache",
		".turbo",
		"build",
		"dist",
		"node_modules",
		"target",
	]);
	const root =
		rootRealPath ??
		(() => {
			const lexical = resolve(directory);
			let real: string;
			try {
				real = resolve(realpathSync(lexical));
			} catch {
				throw new InventoryScanError(lexical, "inventory root realpath failed");
			}
			if (real !== lexical)
				throw new InventoryScanError(
					lexical,
					"inventory root is a symbolic-link alias",
				);
			return real;
		})();
	checkedInventoryPath(resolve(directory), root);
	let entries: Array<{
		readonly name: string;
		readonly isDirectory: () => boolean;
		readonly isFile: () => boolean;
	}>;
	try {
		entries = readdirSync(directory, {
			withFileTypes: true,
			encoding: "utf8",
		}) as unknown as Array<{
			readonly name: string;
			readonly isDirectory: () => boolean;
			readonly isFile: () => boolean;
		}>;
	} catch {
		throw new InventoryScanError(directory, "inventory readdir failed");
	}
	for (const entry of entries.sort((left, right) =>
		compareStrings(left.name, right.name),
	)) {
		const absolute = resolve(directory, entry.name);
		const checked = checkedInventoryPath(absolute, root);
		if (checked.isDirectory) {
			if (!ignoredDirectories.has(entry.name)) {
				walkTypeScriptFiles(absolute, output, includeTests, root);
			}
			continue;
		}
		if (!checked.isFile || !/\.(?:tsx?|mts|cts)$/.test(entry.name)) continue;
		const relativePath = normalizedRelativePath(relative(directory, absolute));
		if (!includeTests && relativePath.endsWith(".test.ts")) continue;
		output.push(absolute);
	}
	return output;
}

function parseAllowlistValue(
	value: unknown,
	filePath: string,
): OfficialIoAllowlist {
	if (!isRecord(value))
		throw new Error(`${filePath}: allowlist must be an object`);
	const objectValue = value as Record<string, unknown>;
	const actualKeys = Object.keys(value).sort(compareStrings);
	const expectedKeys = [...ALLOWLIST_KEYS].sort(compareStrings);
	if (canonicalize(actualKeys) !== canonicalize(expectedKeys)) {
		throw new Error(
			`${filePath}: top-level keys must be exactly ${ALLOWLIST_KEYS.join(", ")}`,
		);
	}

	function strings(key: (typeof ALLOWLIST_KEYS)[number]): string[] {
		const candidate = objectValue[key];
		if (
			!Array.isArray(candidate) ||
			!candidate.every((item) => typeof item === "string")
		) {
			throw new Error(`${filePath}: ${key} must be an array of strings`);
		}
		return candidate as string[];
	}

	function staticImports(): ResolvedStaticImport[] {
		const candidate = objectValue.resolvedStaticImports;
		if (!Array.isArray(candidate)) {
			throw new Error(`${filePath}: resolvedStaticImports must be an array`);
		}
		return candidate.map((item, index) => {
			if (!isRecord(item))
				throw new Error(
					`${filePath}: resolvedStaticImports[${index}] must be an object`,
				);
			const keys = Object.keys(item).sort(compareStrings);
			if (
				canonicalize(keys) !==
				canonicalize(["from", "specifier", "to", "typeOnly"])
			) {
				throw new Error(
					`${filePath}: resolvedStaticImports[${index}] has unexpected fields`,
				);
			}
			if (
				typeof item.from !== "string" ||
				typeof item.specifier !== "string" ||
				typeof item.to !== "string" ||
				typeof item.typeOnly !== "boolean"
			) {
				throw new Error(
					`${filePath}: resolvedStaticImports[${index}] has invalid fields`,
				);
			}
			return {
				from: item.from,
				specifier: item.specifier,
				to: item.to,
				typeOnly: item.typeOnly,
			};
		});
	}

	function loaderExceptions(): PackageLoaderException[] {
		const candidate = objectValue.packageLoaderExceptions;
		if (!Array.isArray(candidate)) {
			throw new Error(`${filePath}: packageLoaderExceptions must be an array`);
		}
		return candidate.map((item, index) => {
			if (!isRecord(item))
				throw new Error(
					`${filePath}: packageLoaderExceptions[${index}] must be an object`,
				);
			const keys = Object.keys(item).sort(compareStrings);
			const expected = [
				"fallbackCandidates",
				"maxAttempts",
				"mechanism",
				"package",
				"requestPattern",
				"source",
				"strictMode",
			].sort(compareStrings);
			if (canonicalize(keys) !== canonicalize(expected)) {
				throw new Error(
					`${filePath}: packageLoaderExceptions[${index}] has unexpected fields`,
				);
			}
			if (
				typeof item.source !== "string" ||
				typeof item.package !== "string" ||
				item.mechanism !== "createRequire" ||
				item.strictMode !== "comparison-supervisor" ||
				item.requestPattern !== "/dev/fd/<validated-addon-fd>" ||
				item.maxAttempts !== 1 ||
				item.fallbackCandidates !== 0
			) {
				throw new Error(
					`${filePath}: packageLoaderExceptions[${index}] is not the reviewed structural exception`,
				);
			}
			return item as unknown as PackageLoaderException;
		});
	}

	return {
		officialRoots: strings("officialRoots"),
		roleChildTs: strings("roleChildTs"),
		protocolOnlyTs: strings("protocolOnlyTs"),
		controllerOnlyTs: strings("controllerOnlyTs"),
		fixtureTs: strings("fixtureTs"),
		checkerTs: strings("checkerTs"),
		cliEntryTs: strings("cliEntryTs"),
		nativeSources: strings("nativeSources"),
		resolvedStaticImports: staticImports(),
		packageLoaderExceptions: loaderExceptions(),
		forbiddenImports: strings("forbiddenImports"),
		forbiddenCalls: strings("forbiddenCalls"),
	};
}

export function loadOfficialIoAllowlist(
	filePath?: string,
	repoRoot?: string,
): OfficialIoAllowlist {
	const auditRoot = resolve(repoRoot ?? defaultRepoRoot());
	const resolvedFile = realpathContainedFile(
		filePath ?? resolve(auditRoot, TOOLS_COMPARE_ROOT, ALLOWLIST_FILE),
		auditRoot,
	);
	const bytes = readFileSync(resolvedFile, "utf8");
	return parseAllowlistValue(JSON.parse(bytes) as unknown, resolvedFile);
}

function defaultRepoRoot(): string {
	const checkerPath = fileURLToPath(import.meta.url);
	return resolve(dirname(checkerPath), "../..");
}

function validateAllowlistShape(
	state: MutableAuditState,
	allowlist: OfficialIoAllowlist,
): void {
	if (
		allowlist.officialRoots.length !== OFFICIAL_ROOTS.length ||
		canonicalize(sortUnique(allowlist.officialRoots)) !==
			canonicalize([...OFFICIAL_ROOTS].sort(compareStrings))
	) {
		reportFile(
			state,
			`${TOOLS_COMPARE_ROOT}/${ALLOWLIST_FILE}`,
			"OFFICIAL_ROOTS_INVALID",
			"officialRoots must contain exactly the four frozen child roots",
		);
	}
	if (
		allowlist.checkerTs.length !== 1 ||
		allowlist.checkerTs[0] !== CHECKER_FILE
	) {
		reportFile(
			state,
			`${TOOLS_COMPARE_ROOT}/${ALLOWLIST_FILE}`,
			"CHECKER_CLASS_INVALID",
			"checkerTs must contain exactly check-official-io.ts",
		);
	}
	if (
		allowlist.fixtureTs.length !== 1 ||
		allowlist.fixtureTs[0] !== "r1-fixtures.ts"
	) {
		reportFile(
			state,
			`${TOOLS_COMPARE_ROOT}/${ALLOWLIST_FILE}`,
			"FIXTURE_CLASS_INVALID",
			"fixtureTs must contain exactly r1-fixtures.ts",
		);
	}
	const expectedControllers = [
		"host-sidecar.ts",
		"netem.ts",
		"remote-supervisor.ts",
		"topology.ts",
		"bin/compare-controller.ts",
	];
	if (
		new Set(allowlist.controllerOnlyTs).size !==
		allowlist.controllerOnlyTs.length
	) {
		reportFile(
			state,
			`${TOOLS_COMPARE_ROOT}/${ALLOWLIST_FILE}`,
			"ALLOWLIST_DUPLICATE_CLASSIFICATION",
			"controllerOnlyTs contains duplicate entries",
		);
	}
	if (
		canonicalize(sortUnique(allowlist.controllerOnlyTs)) !==
		canonicalize(sortUnique(expectedControllers))
	) {
		reportFile(
			state,
			`${TOOLS_COMPARE_ROOT}/${ALLOWLIST_FILE}`,
			"CONTROLLER_CLASS_INVALID",
			"controllerOnlyTs must contain exactly the five frozen controller modules",
		);
	}
	const expectedNative = [
		"crates/native/src/bin/comparison-supervisor.rs",
		"crates/native/src/secure_fs.rs",
	];
	if (
		new Set(allowlist.nativeSources).size !== allowlist.nativeSources.length
	) {
		reportFile(
			state,
			`${TOOLS_COMPARE_ROOT}/${ALLOWLIST_FILE}`,
			"ALLOWLIST_DUPLICATE_ENTRY",
			"nativeSources contains duplicate entries",
		);
	}
	if (
		canonicalize(sortUnique(allowlist.nativeSources)) !==
		canonicalize(expectedNative)
	) {
		reportFile(
			state,
			`${TOOLS_COMPARE_ROOT}/${ALLOWLIST_FILE}`,
			"NATIVE_CLASS_INVALID",
			"nativeSources must contain exactly the two sealed supervisor sources",
		);
	}
	if (allowlist.packageLoaderExceptions.length !== 1) {
		reportFile(
			state,
			`${TOOLS_COMPARE_ROOT}/${ALLOWLIST_FILE}`,
			"LOADER_EXCEPTION_INVALID",
			"exactly one structural package-loader exception is permitted",
		);
	} else {
		const exception = allowlist.packageLoaderExceptions[0];
		if (
			exception?.source !== packageLoaderSource ||
			exception.package !== packageLoaderPackage ||
			exception.mechanism !== "createRequire" ||
			exception.strictMode !== "comparison-supervisor" ||
			exception.requestPattern !== "/dev/fd/<validated-addon-fd>" ||
			exception.maxAttempts !== 1 ||
			exception.fallbackCandidates !== 0
		) {
			reportFile(
				state,
				`${TOOLS_COMPARE_ROOT}/${ALLOWLIST_FILE}`,
				"LOADER_EXCEPTION_INVALID",
				"loader exception must match the sole reviewed WT package descriptor contract",
			);
		}
	}
	for (const [key, values] of [
		["officialRoots", allowlist.officialRoots],
		["roleChildTs", allowlist.roleChildTs],
		["protocolOnlyTs", allowlist.protocolOnlyTs],
		["controllerOnlyTs", allowlist.controllerOnlyTs],
		["fixtureTs", allowlist.fixtureTs],
		["checkerTs", allowlist.checkerTs],
	] as const) {
		const seen = new Set<string>();
		for (const value of values) {
			if (seen.has(value)) {
				reportFile(
					state,
					`${TOOLS_COMPARE_ROOT}/${ALLOWLIST_FILE}`,
					"ALLOWLIST_DUPLICATE_CLASSIFICATION",
					`${key} contains duplicate '${value}'`,
				);
			}
			seen.add(value);
			if (
				value.includes("\\") ||
				value.startsWith("/") ||
				value.includes("..")
			) {
				reportFile(
					state,
					`${TOOLS_COMPARE_ROOT}/${ALLOWLIST_FILE}`,
					"ALLOWLIST_PATH_INVALID",
					`${key} contains non-relative path '${value}'`,
				);
			}
			if (value.endsWith(".test.ts")) {
				reportFile(
					state,
					`${TOOLS_COMPARE_ROOT}/${ALLOWLIST_FILE}`,
					"ALLOWLIST_TEST_CLASSIFIED",
					`${key} cannot classify test file '${value}'`,
				);
			}
		}
	}
	const allClassified = [
		...allowlist.officialRoots,
		...allowlist.roleChildTs,
		...allowlist.protocolOnlyTs,
		...allowlist.controllerOnlyTs,
		...allowlist.fixtureTs,
		...allowlist.checkerTs,
	];
	if (allClassified.includes("remote.ts")) {
		reportFile(
			state,
			`${TOOLS_COMPARE_ROOT}/remote.ts`,
			"LEGACY_REMOTE_CLASSIFIED",
			"deleted legacy remote.ts must not be reintroduced into any TypeScript class",
		);
	}
	const counts = new Map<string, number>();
	for (const file of allClassified)
		counts.set(file, (counts.get(file) ?? 0) + 1);
	for (const [file, count] of counts) {
		if (count !== 1) {
			reportFile(
				state,
				`${TOOLS_COMPARE_ROOT}/${file}`,
				"ALLOWLIST_DUPLICATE_CLASSIFICATION",
				`file is classified ${count} times`,
			);
		}
	}
	const forbiddenImports = new Set(allowlist.forbiddenImports);
	for (const required of FORBIDDEN_IMPORTS) {
		if (!forbiddenImports.has(required)) {
			reportFile(
				state,
				`${TOOLS_COMPARE_ROOT}/${ALLOWLIST_FILE}`,
				"FORBIDDEN_IMPORT_ALLOWLIST_INCOMPLETE",
				`forbiddenImports omits '${required}'`,
			);
		}
	}
	for (const required of FORBIDDEN_CALLS) {
		if (!allowlist.forbiddenCalls.includes(required)) {
			reportFile(
				state,
				`${TOOLS_COMPARE_ROOT}/${ALLOWLIST_FILE}`,
				"FORBIDDEN_CALL_ALLOWLIST_INCOMPLETE",
				`forbiddenCalls omits '${required}'`,
			);
		}
	}
	for (const [key, values] of [
		["forbiddenImports", allowlist.forbiddenImports],
		["forbiddenCalls", allowlist.forbiddenCalls],
	] as const) {
		const seen = new Set<string>();
		for (const value of values) {
			if (seen.has(value)) {
				reportFile(
					state,
					`${TOOLS_COMPARE_ROOT}/${ALLOWLIST_FILE}`,
					"ALLOWLIST_DUPLICATE_ENTRY",
					`${key} contains duplicate '${value}'`,
				);
			}
			seen.add(value);
		}
	}
}

function classEntries(
	allowlist: OfficialIoAllowlist,
): Array<{ readonly class: TypeScriptClass; readonly path: string }> {
	return [
		...allowlist.officialRoots.map((path) => ({
			class: "officialRoots" as const,
			path,
		})),
		...allowlist.roleChildTs.map((path) => ({
			class: "roleChildTs" as const,
			path,
		})),
		...allowlist.protocolOnlyTs.map((path) => ({
			class: "protocolOnlyTs" as const,
			path,
		})),
		...allowlist.controllerOnlyTs.map((path) => ({
			class: "controllerOnlyTs" as const,
			path,
		})),
		...allowlist.cliEntryTs.map((path) => ({
			class: "cliEntryTs" as const,
			path,
		})),
		...allowlist.fixtureTs.map((path) => ({
			class: "fixtureTs" as const,
			path,
		})),
		...allowlist.checkerTs.map((path) => ({
			class: "checkerTs" as const,
			path,
		})),
	];
}

function classifyFiles(state: MutableAuditState): ClassifiedFile[] {
	const compareRoot = resolve(state.repoRoot, TOOLS_COMPARE_ROOT);
	let actualFiles: string[] = [];
	try {
		actualFiles = walkTypeScriptFiles(compareRoot)
			.map((absolute) =>
				normalizedRelativePath(relative(compareRoot, absolute)),
			)
			.sort(compareStrings);
	} catch (error: unknown) {
		const message =
			error instanceof InventoryScanError
				? error.message
				: `inventory scan failed: ${String(error)}`;
		reportFile(state, TOOLS_COMPARE_ROOT, "INVENTORY_SCAN_FAILED", message);
	}
	const expected = classEntries(state.allowlist);
	const classByPath = new Map<string, TypeScriptClass>();
	for (const entry of expected) {
		if (classByPath.has(entry.path)) continue;
		classByPath.set(entry.path, entry.class);
	}
	const classified: ClassifiedFile[] = [];
	for (const entry of expected) {
		const absolute = resolve(compareRoot, entry.path);
		if (!isWithin(compareRoot, absolute)) {
			reportFile(
				state,
				`${TOOLS_COMPARE_ROOT}/${entry.path}`,
				"ALLOWLIST_PATH_INVALID",
				"allowlisted TypeScript path escapes tools/compare",
			);
			classified.push({
				path: `${TOOLS_COMPARE_ROOT}/${entry.path}`,
				class: entry.class,
				sha256: null,
			});
			continue;
		}
		if (!existsSync(absolute)) {
			reportFile(
				state,
				`${TOOLS_COMPARE_ROOT}/${entry.path}`,
				"ALLOWLIST_FILE_MISSING",
				`allowlisted ${entry.class} file is missing`,
			);
			classified.push({
				path: `${TOOLS_COMPARE_ROOT}/${entry.path}`,
				class: entry.class,
				sha256: null,
			});
			continue;
		}
		let digest: string | null = null;
		try {
			digest = sha256Bytes(readFileSync(absolute));
		} catch {
			reportFile(
				state,
				`${TOOLS_COMPARE_ROOT}/${entry.path}`,
				"SOURCE_READ_FAILED",
				"cannot hash allowlisted file",
			);
		}
		classified.push({
			path: `${TOOLS_COMPARE_ROOT}/${entry.path}`,
			class: entry.class,
			sha256: digest,
		});
	}
	for (const actualPath of actualFiles) {
		if (classByPath.has(actualPath)) continue;
		reportFile(
			state,
			`${TOOLS_COMPARE_ROOT}/${actualPath}`,
			"ALLOWLIST_EXTRA_FILE",
			"non-test TypeScript file is not classified by the frozen allowlist",
		);
		let digest: string | null = null;
		try {
			digest = sha256Bytes(readFileSync(resolve(compareRoot, actualPath)));
		} catch {
			reportFile(
				state,
				`${TOOLS_COMPARE_ROOT}/${actualPath}`,
				"SOURCE_READ_FAILED",
				"cannot hash unclassified file",
			);
		}
		classified.push({
			path: `${TOOLS_COMPARE_ROOT}/${actualPath}`,
			class: "unclassified",
			sha256: digest,
		});
	}
	return classified.sort((left, right) =>
		compareStrings(left.path, right.path),
	);
}

function isRequireCall(
	node: ts.CallExpression,
	requireAliases: ReadonlySet<string> = new Set(),
	moduleAliases: ReadonlySet<string> = new Set(),
): boolean {
	if (ts.isIdentifier(node.expression))
		return requireAliases.has(node.expression.text);
	return (
		(ts.isPropertyAccessExpression(node.expression) ||
			ts.isElementAccessExpression(node.expression)) &&
		ts.isIdentifier(node.expression.expression) &&
		(node.expression.expression.text === "module" ||
			moduleAliases.has(node.expression.expression.text)) &&
		getStringProperty(node.expression) === "require"
	);
}

interface ModuleCallAliases {
	readonly requireAliases: Set<string>;
	readonly moduleAliases: Set<string>;
	readonly createRequireAliases: Set<string>;
	readonly loaderAliases: Set<string>;
}

function unwrapModuleExpression(
	expression: ts.Expression | undefined,
): ts.Expression | undefined {
	if (!expression) return undefined;
	if (ts.isParenthesizedExpression(expression))
		return unwrapModuleExpression(expression.expression);
	if (
		ts.isAsExpression(expression) ||
		ts.isTypeAssertionExpression(expression) ||
		ts.isNonNullExpression(expression) ||
		ts.isSatisfiesExpression(expression)
	)
		return unwrapModuleExpression(expression.expression);
	return expression;
}

function collectModuleCallAliases(
	sourceFile: ts.SourceFile,
): ModuleCallAliases {
	// `require` and `module` are ambient Node names.  Keep their aliases as
	// over-approximations: a false positive is safe for this checker, while a
	// missed reassignment would allow a production loader bypass.
	const requireAliases = new Set<string>(["require"]);
	const moduleAliases = new Set<string>();
	const createRequireAliases = new Set<string>();
	const loaderAliases = new Set<string>();
	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement)) {
			const specifier = moduleSpecifierText(statement.moduleSpecifier);
			if (canonicalBuiltinSpecifier(specifier ?? "") !== "node:module")
				continue;
			const clause = statement.importClause;
			if (clause?.name && !clause.isTypeOnly)
				moduleAliases.add(clause.name.text);
			const bindings = clause?.namedBindings;
			if (bindings && ts.isNamespaceImport(bindings))
				moduleAliases.add(bindings.name.text);
			if (bindings && ts.isNamedImports(bindings)) {
				for (const element of bindings.elements) {
					if (element.isTypeOnly) continue;
					const imported = element.propertyName?.text ?? element.name.text;
					if (imported === "createRequire")
						createRequireAliases.add(element.name.text);
					if (imported === "require") requireAliases.add(element.name.text);
				}
			}
		}
		if (ts.isImportEqualsDeclaration(statement)) {
			const reference = statement.moduleReference;
			if (!ts.isExternalModuleReference(reference) || !reference.expression)
				continue;
			const expression = unwrapModuleExpression(reference.expression);
			if (!expression) continue;
			if (ts.isCallExpression(expression)) {
				if (nodeModuleRequireCall(expression, requireAliases, moduleAliases))
					moduleAliases.add(statement.name.text);
				continue;
			}
			if (
				ts.isPropertyAccessExpression(expression) ||
				ts.isElementAccessExpression(expression)
			) {
				const base = expression.expression;
				if (
					getStringProperty(expression) === "createRequire" &&
					ts.isCallExpression(base) &&
					nodeModuleRequireCall(base, requireAliases, moduleAliases)
				)
					createRequireAliases.add(statement.name.text);
			}
		}
	}
	const isNamespace = (name: string): boolean => moduleAliases.has(name);
	const isRequireReference = (
		expression: ts.Expression | undefined,
	): boolean => {
		const unwrapped = unwrapModuleExpression(expression);
		if (unwrapped && ts.isIdentifier(unwrapped))
			return requireAliases.has(unwrapped.text);
		return (
			!!unwrapped &&
			(ts.isPropertyAccessExpression(unwrapped) ||
				ts.isElementAccessExpression(unwrapped)) &&
			ts.isIdentifier(unwrapped.expression) &&
			(unwrapped.expression.text === "module" ||
				isNamespace(unwrapped.expression.text)) &&
			getStringProperty(unwrapped) === "require"
		);
	};
	const isCreateRequireReference = (
		expression: ts.Expression | undefined,
	): boolean => {
		const unwrapped = unwrapModuleExpression(expression);
		if (unwrapped && ts.isIdentifier(unwrapped))
			return createRequireAliases.has(unwrapped.text);
		return (
			!!unwrapped &&
			(ts.isPropertyAccessExpression(unwrapped) ||
				ts.isElementAccessExpression(unwrapped)) &&
			!!getStringProperty(unwrapped) &&
			getStringProperty(unwrapped) === "createRequire" &&
			((ts.isIdentifier(unwrapped.expression) &&
				isNamespace(unwrapped.expression.text)) ||
				(ts.isCallExpression(unwrapped.expression) &&
					nodeModuleRequireCall(
						unwrapped.expression,
						requireAliases,
						moduleAliases,
					)))
		);
	};
	const isLoaderFactoryCall = (
		expression: ts.Expression | undefined,
	): boolean => {
		const unwrapped = unwrapModuleExpression(expression);
		return (
			(!!unwrapped &&
				ts.isIdentifier(unwrapped) &&
				createRequireAliases.has(unwrapped.text)) ||
			isCreateRequireReference(unwrapped)
		);
	};
	const isLoaderReference = (
		expression: ts.Expression | undefined,
	): boolean => {
		const unwrapped = unwrapModuleExpression(expression);
		return (
			!!unwrapped &&
			ts.isIdentifier(unwrapped) &&
			loaderAliases.has(unwrapped.text)
		);
	};
	for (let round = 0; round < 12; round += 1) {
		let changed = false;
		const add = (set: Set<string>, name: string): void => {
			if (!set.has(name)) {
				set.add(name);
				changed = true;
			}
		};
		function visit(node: ts.Node): void {
			if (ts.isVariableDeclaration(node)) {
				if (ts.isIdentifier(node.name)) {
					const name = node.name.text;
					const initializer = unwrapModuleExpression(node.initializer);
					if (initializer && ts.isIdentifier(initializer)) {
						if (requireAliases.has(initializer.text)) add(requireAliases, name);
						if (moduleAliases.has(initializer.text)) add(moduleAliases, name);
						if (createRequireAliases.has(initializer.text))
							add(createRequireAliases, name);
						if (loaderAliases.has(initializer.text)) add(loaderAliases, name);
					}
					if (isRequireReference(initializer)) add(requireAliases, name);
					if (
						initializer &&
						ts.isCallExpression(initializer) &&
						nodeModuleRequireCall(initializer, requireAliases, moduleAliases)
					)
						add(moduleAliases, name);
					if (isCreateRequireReference(initializer))
						add(createRequireAliases, name);
					if (initializer && ts.isCallExpression(initializer)) {
						if (isLoaderFactoryCall(initializer.expression))
							add(loaderAliases, name);
						if (isLoaderReference(initializer.expression))
							add(loaderAliases, name);
					}
				}
				if (node.name.kind !== ts.SyntaxKind.Identifier && node.initializer) {
					const destructuredInitializer = unwrapModuleExpression(
						node.initializer,
					);
					if (
						destructuredInitializer &&
						((ts.isIdentifier(destructuredInitializer) &&
							isNamespace(destructuredInitializer.text)) ||
							(ts.isCallExpression(destructuredInitializer) &&
								nodeModuleRequireCall(
									destructuredInitializer,
									requireAliases,
									moduleAliases,
								)))
					) {
						for (const binding of bindingNames(node.name)) {
							if (binding.property === "require")
								add(requireAliases, binding.name);
							if (binding.property === "createRequire")
								add(createRequireAliases, binding.name);
						}
					}
				}
			}
			if (
				ts.isBinaryExpression(node) &&
				node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
				ts.isIdentifier(node.left)
			) {
				const right = unwrapModuleExpression(node.right);
				if (right && ts.isIdentifier(right)) {
					if (requireAliases.has(right.text))
						add(requireAliases, node.left.text);
					if (moduleAliases.has(right.text)) add(moduleAliases, node.left.text);
					if (createRequireAliases.has(right.text))
						add(createRequireAliases, node.left.text);
					if (loaderAliases.has(right.text)) add(loaderAliases, node.left.text);
				}
				if (right && ts.isCallExpression(right)) {
					if (nodeModuleRequireCall(right, requireAliases, moduleAliases))
						add(moduleAliases, node.left.text);
					if (
						isLoaderFactoryCall(right.expression) ||
						isLoaderReference(right.expression)
					)
						add(loaderAliases, node.left.text);
				}
			}
			ts.forEachChild(node, visit);
		}
		visit(sourceFile);
		if (!changed) break;
	}
	return { requireAliases, moduleAliases, createRequireAliases, loaderAliases };
}

function nodeModuleRequireCall(
	node: ts.CallExpression,
	requireAliases: ReadonlySet<string>,
	moduleAliases: ReadonlySet<string>,
): boolean {
	return (
		node.arguments.length === 1 &&
		moduleSpecifierText(node.arguments[0]) === "node:module" &&
		isRequireCall(node, requireAliases, moduleAliases)
	);
}

function isCreateRequireReferenceForAliases(
	expression: ts.Expression | undefined,
	aliases: ModuleCallAliases,
): boolean {
	const unwrapped = unwrapModuleExpression(expression);
	if (unwrapped && ts.isIdentifier(unwrapped))
		return aliases.createRequireAliases.has(unwrapped.text);
	if (
		!unwrapped ||
		(!ts.isPropertyAccessExpression(unwrapped) &&
			!ts.isElementAccessExpression(unwrapped)) ||
		getStringProperty(unwrapped) !== "createRequire"
	)
		return false;
	if (ts.isIdentifier(unwrapped.expression))
		return aliases.moduleAliases.has(unwrapped.expression.text);
	return (
		ts.isCallExpression(unwrapped.expression) &&
		nodeModuleRequireCall(
			unwrapped.expression,
			aliases.requireAliases,
			aliases.moduleAliases,
		)
	);
}

function isCreateRequireCallForAliases(
	node: ts.CallExpression,
	aliases: ModuleCallAliases,
): boolean {
	return isCreateRequireReferenceForAliases(node.expression, aliases);
}

function isLoaderCalleeForAliases(
	expression: ts.Expression | undefined,
	aliases: ModuleCallAliases,
): boolean {
	const unwrapped = unwrapModuleExpression(expression);
	return (
		(!!unwrapped &&
			ts.isIdentifier(unwrapped) &&
			aliases.loaderAliases.has(unwrapped.text)) ||
		(!!unwrapped &&
			ts.isCallExpression(unwrapped) &&
			isCreateRequireReferenceForAliases(unwrapped.expression, aliases))
	);
}

function isTestPath(path: string): boolean {
	return path.endsWith(".test.ts");
}

function isExactAllowedCheckerTestEdge(
	source: SourceRecord,
	node: ts.Node,
	specifier: string,
	target: ResolvedTarget,
	checkerAbsolute: string,
): boolean {
	if (
		source.relativePath !== "tools/compare/r1-entrypoint-red.test.ts" ||
		specifier !== "./check-official-io.ts" ||
		target.external ||
		target.absoluteTarget !== checkerAbsolute ||
		!ts.isImportDeclaration(node) ||
		!node.importClause ||
		node.importClause.isTypeOnly ||
		!node.importClause.namedBindings ||
		!ts.isNamedImports(node.importClause.namedBindings) ||
		!!node.importClause.name
	)
		return false;
	const elements = node.importClause.namedBindings.elements;
	if (
		elements.length !== 2 ||
		elements.some((element) => element.isTypeOnly || element.propertyName)
	)
		return false;
	const names = elements
		.map((element) => element.name.text)
		.sort(compareStrings);
	return (
		names.length === 2 &&
		names[0] === "formatOfficialIoAudit" &&
		names[1] === "runOfficialIoAudit"
	);
}

function moduleTargetReaches(
	state: MutableAuditState,
	absolutePath: string,
	checkerAbsolute: string,
	memo: Map<string, boolean>,
	visiting: Set<string>,
): boolean {
	const normalized = resolve(absolutePath);
	if (normalized === checkerAbsolute) return true;
	const cached = memo.get(normalized);
	if (cached !== undefined) return cached;
	if (visiting.has(normalized)) return false;
	visiting.add(normalized);
	const source = parseSource(state, normalized);
	let reaches = false;
	if (source) {
		const sourceRecord = source;
		const aliases = collectModuleCallAliases(sourceRecord.sourceFile);
		function checkSpecifier(specifier: string): boolean {
			const target = resolveTarget(
				state.repoRoot,
				sourceRecord.absolutePath,
				specifier,
			);
			return (
				!!target?.absoluteTarget &&
				isWithin(state.repoRoot, target.absoluteTarget) &&
				moduleTargetReaches(
					state,
					target.absoluteTarget,
					checkerAbsolute,
					memo,
					visiting,
				)
			);
		}
		function visit(node: ts.Node): void {
			if (reaches) return;
			if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
				const specifier = moduleSpecifierText(node.moduleSpecifier);
				if (specifier && checkSpecifier(specifier)) reaches = true;
			}
			if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
				const specifier = literalText(node.argument.literal);
				if (specifier && checkSpecifier(specifier)) reaches = true;
			}
			if (ts.isImportEqualsDeclaration(node)) {
				const reference = node.moduleReference;
				if (ts.isExternalModuleReference(reference) && reference.expression) {
					const specifier = literalText(reference.expression);
					if (specifier && checkSpecifier(specifier)) reaches = true;
				}
			}
			if (ts.isCallExpression(node) && node.arguments.length === 1) {
				const dynamicImport =
					node.expression.kind === ts.SyntaxKind.ImportKeyword;
				const loaderCall = isLoaderCalleeForAliases(node.expression, aliases);
				const computedModuleCall =
					ts.isElementAccessExpression(node.expression) &&
					ts.isIdentifier(node.expression.expression) &&
					(node.expression.expression.text === "module" ||
						aliases.moduleAliases.has(node.expression.expression.text)) &&
					getStringProperty(node.expression) === undefined;
				if (
					dynamicImport ||
					isRequireCall(node, aliases.requireAliases, aliases.moduleAliases) ||
					(isCreateRequireCallForAliases(node, aliases) &&
						node.arguments.length === 1) ||
					computedModuleCall ||
					loaderCall
				) {
					const specifier = moduleSpecifierText(node.arguments[0]);
					if (specifier && checkSpecifier(specifier)) reaches = true;
				}
			}
			ts.forEachChild(node, visit);
		}
		visit(source.sourceFile);
	}
	visiting.delete(normalized);
	memo.set(normalized, reaches);
	return reaches;
}

function validateCheckerIsolation(state: MutableAuditState): void {
	const compareRoot = resolve(state.repoRoot, TOOLS_COMPARE_ROOT);
	const checkerAbsolute = resolve(compareRoot, CHECKER_FILE);
	const memo = new Map<string, boolean>();
	let files: string[] = [];
	try {
		files = walkTypeScriptFiles(state.repoRoot, [], true);
	} catch (error: unknown) {
		reportFile(
			state,
			repoRelative(
				state.repoRoot,
				error instanceof InventoryScanError
					? resolve(error.path)
					: state.repoRoot,
			),
			"INVENTORY_SCAN_FAILED",
			error instanceof Error ? error.message : String(error),
		);
	}
	for (const absolutePath of files) {
		const normalized = resolve(absolutePath);
		if (normalized === checkerAbsolute || isTestPath(normalized)) {
			continue;
		}
		const source = parseSource(state, normalized);
		if (!source) continue;
		const sourceRecord = source;
		// Full static reviewability is the comparison tree's contract; for the
		// rest of the repository this pass only answers "can it reach the
		// checker", so an unresolvable EXTERNAL package name (which can never
		// be the checker) is not a finding there, and a dynamic import cannot
		// be shown to reach the checker but is the loader-graph pass's problem
		// where it matters.
		const strictReviewability = isWithin(compareRoot, normalized);
		const aliases = collectModuleCallAliases(sourceRecord.sourceFile);
		function inspectSpecifier(node: ts.Node, specifier: string): void {
			const target = resolveTarget(
				state.repoRoot,
				sourceRecord.absolutePath,
				specifier,
			);
			const relativeSpecifier =
				specifier.startsWith("./") ||
				specifier.startsWith("../") ||
				specifier.startsWith("/");
			if (
				!target &&
				!isBuiltinSpecifier(specifier) &&
				(strictReviewability || relativeSpecifier)
			) {
				reportNode(
					state,
					sourceRecord,
					node,
					"PRODUCTION_IMPORT_UNRESOLVED",
					`production module edge '${specifier}' does not resolve under the realpath-contained resolver`,
				);
				return;
			}
			if (!target) return;
			if (
				target?.absoluteTarget &&
				isWithin(state.repoRoot, target.absoluteTarget) &&
				moduleTargetReaches(
					state,
					target.absoluteTarget,
					checkerAbsolute,
					memo,
					new Set(),
				)
			) {
				reportNode(
					state,
					sourceRecord,
					node,
					"CHECKER_PRODUCTION_IMPORT",
					"audit checker is reachable from a production TypeScript module",
				);
			}
		}
		function visit(node: ts.Node): void {
			if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
				const specifier = moduleSpecifierText(node.moduleSpecifier);
				if (specifier) inspectSpecifier(node, specifier);
			}
			if (ts.isImportTypeNode(node)) {
				if (ts.isLiteralTypeNode(node.argument)) {
					const specifier = literalText(node.argument.literal);
					if (specifier) inspectSpecifier(node, specifier);
				} else {
					if (strictReviewability)
						reportNode(
							state,
							sourceRecord,
							node,
							"PRODUCTION_DYNAMIC_MODULE_REACHABILITY",
							"production type import must use a literal module specifier",
						);
				}
			}
			if (ts.isImportEqualsDeclaration(node)) {
				const reference = node.moduleReference;
				if (!ts.isExternalModuleReference(reference) || !reference.expression) {
					if (strictReviewability)
						reportNode(
							state,
							sourceRecord,
							node,
							"PRODUCTION_DYNAMIC_MODULE_REACHABILITY",
							"production import= must use a statically reviewable external module reference",
						);
					return;
				}
				const specifier = literalText(reference.expression);
				if (specifier) inspectSpecifier(node, specifier);
				else {
					if (strictReviewability)
						reportNode(
							state,
							sourceRecord,
							node,
							"PRODUCTION_DYNAMIC_MODULE_REACHABILITY",
							"production import=require must use a literal module specifier",
						);
				}
			}
			if (ts.isCallExpression(node)) {
				const dynamicImport =
					node.expression.kind === ts.SyntaxKind.ImportKeyword;
				const requireCall = isRequireCall(
					node,
					aliases.requireAliases,
					aliases.moduleAliases,
				);
				const loaderCall = isLoaderCalleeForAliases(node.expression, aliases);
				const computedModuleCall =
					ts.isElementAccessExpression(node.expression) &&
					ts.isIdentifier(node.expression.expression) &&
					(node.expression.expression.text === "module" ||
						aliases.moduleAliases.has(node.expression.expression.text)) &&
					getStringProperty(node.expression) === undefined;
				const createRequireCall = isCreateRequireCallForAliases(node, aliases);
				if (
					dynamicImport ||
					requireCall ||
					createRequireCall ||
					computedModuleCall ||
					loaderCall
				) {
					const argument = node.arguments[0];
					const specifier = moduleSpecifierText(argument);
					if (specifier) inspectSpecifier(node, specifier);
					else if (strictReviewability) {
						reportNode(
							state,
							sourceRecord,
							node,
							"PRODUCTION_DYNAMIC_MODULE_REACHABILITY",
							"production require/import must use a literal module specifier",
						);
					}
				}
			}
			ts.forEachChild(node, visit);
		}
		visit(source.sourceFile);
	}
}

function validateTestImports(state: MutableAuditState): void {
	const compareRoot = resolve(state.repoRoot, TOOLS_COMPARE_ROOT);
	const checkerAbsolute = resolve(compareRoot, CHECKER_FILE);
	const checkerReachabilityMemo = new Map<string, boolean>();
	let exactCheckerEdgeCount = 0;
	const classByPath = new Map<string, TypeScriptClass>();
	for (const entry of classEntries(state.allowlist)) {
		classByPath.set(entry.path, entry.class);
	}
	const classifyTarget = (
		absoluteTarget: string,
	): TypeScriptClass | "test" | "unapproved" => {
		const normalized = resolve(absoluteTarget);
		if (isTestPath(normalized)) return "test";
		if (isWithin(compareRoot, normalized)) {
			const path = normalizedRelativePath(relative(compareRoot, normalized));
			return classByPath.get(path) ?? "unapproved";
		}
		const repoPath = repoRelative(state.repoRoot, normalized);
		if (
			(repoPath.startsWith("packages/") || repoPath.startsWith("src/")) &&
			!repoPath.startsWith("node_modules/")
		) {
			return "officialRoots";
		}
		return "unapproved";
	};
	const inspect = (
		source: SourceRecord,
		node: ts.Node,
		specifier: string,
	): void => {
		if (isBuiltinSpecifier(specifier)) return;
		const target = resolveTarget(
			state.repoRoot,
			source.absolutePath,
			specifier,
		);
		if (!target) {
			reportNode(
				state,
				source,
				node,
				"TEST_IMPORT_UNRESOLVED",
				`test import '${specifier}' does not resolve`,
			);
			return;
		}
		if (target.external) {
			reportNode(
				state,
				source,
				node,
				"TEST_IMPORT_EXTERNAL_FORBIDDEN",
				`test import '${specifier}' targets an unapproved external module`,
			);
			return;
		}
		if (!target.absoluteTarget) return;
		if (
			isExactAllowedCheckerTestEdge(
				source,
				node,
				specifier,
				target,
				checkerAbsolute,
			)
		) {
			exactCheckerEdgeCount += 1;
			if (exactCheckerEdgeCount > 1) {
				reportNode(
					state,
					source,
					node,
					"CHECKER_TEST_EDGE_DUPLICATE",
					"the audit checker may have exactly one r1-entrypoint test edge",
				);
			}
			return;
		}
		if (
			moduleTargetReaches(
				state,
				target.absoluteTarget,
				checkerAbsolute,
				checkerReachabilityMemo,
				new Set(),
			)
		) {
			reportNode(
				state,
				source,
				node,
				"TEST_IMPORT_CHECKER_FORBIDDEN",
				"tests may not import a module that reaches the audit checker",
			);
			return;
		}
		const classification = classifyTarget(target.absoluteTarget);
		if (classification === "test") {
			reportNode(
				state,
				source,
				node,
				"TEST_IMPORT_TEST_FORBIDDEN",
				"test modules may not import another .test.ts module",
			);
		} else if (classification === "unapproved") {
			reportNode(
				state,
				source,
				node,
				"TEST_IMPORT_UNAPPROVED",
				`test import '${specifier}' is not fixtureTs or a reviewed production API`,
			);
		} else if (classification === "checkerTs") {
			reportNode(
				state,
				source,
				node,
				"TEST_IMPORT_CHECKER_FORBIDDEN",
				"tests may not import the audit checker",
			);
		} else if (classification === "controllerOnlyTs") {
			reportNode(
				state,
				source,
				node,
				"TEST_IMPORT_CONTROLLER_FORBIDDEN",
				"tests may not import controller-only modules",
			);
		}
	};
	let testFiles: string[] = [];
	try {
		// The test-import contract ("tests may import only fixtureTs plus
		// production APIs") governs the comparison's own tests; the rest of
		// the repository's tests are outside this allowlist's scope.
		testFiles = walkTypeScriptFiles(compareRoot, [], true);
	} catch (error: unknown) {
		reportFile(
			state,
			repoRelative(
				state.repoRoot,
				error instanceof InventoryScanError
					? resolve(error.path)
					: state.repoRoot,
			),
			"INVENTORY_SCAN_FAILED",
			error instanceof Error ? error.message : String(error),
		);
	}
	for (const absolutePath of testFiles) {
		if (!isTestPath(absolutePath)) continue;
		const source = parseSource(state, absolutePath);
		if (!source) continue;
		const sourceRecord = source;
		const aliases = collectModuleCallAliases(sourceRecord.sourceFile);
		function visit(node: ts.Node): void {
			if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
				const specifier = moduleSpecifierText(node.moduleSpecifier);
				if (specifier) inspect(sourceRecord, node, specifier);
			}
			if (ts.isImportTypeNode(node)) {
				if (ts.isLiteralTypeNode(node.argument)) {
					const specifier = literalText(node.argument.literal);
					if (specifier) inspect(sourceRecord, node, specifier);
				} else {
					reportNode(
						state,
						sourceRecord,
						node,
						"TEST_IMPORT_UNRESOLVED",
						"test type import must use a literal module specifier",
					);
				}
			}
			if (ts.isImportEqualsDeclaration(node)) {
				const reference = node.moduleReference;
				if (ts.isExternalModuleReference(reference) && reference.expression) {
					const specifier = literalText(reference.expression);
					if (specifier) inspect(sourceRecord, node, specifier);
					else
						reportNode(
							state,
							sourceRecord,
							node,
							"TEST_IMPORT_UNRESOLVED",
							"test import=require must use a literal module specifier",
						);
				} else {
					reportNode(
						state,
						sourceRecord,
						node,
						"TEST_IMPORT_UNRESOLVED",
						"test import= must use a statically reviewable external module reference",
					);
				}
			}
			if (ts.isCallExpression(node)) {
				const dynamicImport =
					node.expression.kind === ts.SyntaxKind.ImportKeyword;
				const requireCall = isRequireCall(
					node,
					aliases.requireAliases,
					aliases.moduleAliases,
				);
				const loaderCall = isLoaderCalleeForAliases(node.expression, aliases);
				const computedModuleCall =
					ts.isElementAccessExpression(node.expression) &&
					ts.isIdentifier(node.expression.expression) &&
					(node.expression.expression.text === "module" ||
						aliases.moduleAliases.has(node.expression.expression.text)) &&
					getStringProperty(node.expression) === undefined;
				const createRequireCall = isCreateRequireCallForAliases(node, aliases);
				if (
					dynamicImport ||
					requireCall ||
					createRequireCall ||
					computedModuleCall ||
					loaderCall
				) {
					const specifier = moduleSpecifierText(node.arguments[0]);
					if (specifier) inspect(sourceRecord, node, specifier);
					else
						reportNode(
							state,
							sourceRecord,
							node,
							"TEST_IMPORT_UNRESOLVED",
							"test require/import must use a literal module specifier",
						);
				}
			}
			ts.forEachChild(node, visit);
		}
		visit(sourceRecord.sourceFile);
	}
	if (exactCheckerEdgeCount !== 1) {
		reportFile(
			state,
			"tools/compare/r1-entrypoint-red.test.ts",
			"CHECKER_TEST_EDGE_CARDINALITY",
			"the audit checker requires exactly one r1-entrypoint test edge",
		);
	}
}

function edgeKey(edge: ResolvedStaticImport): string {
	return canonicalize(edge);
}

function observedEdges(state: MutableAuditState): ResolvedStaticImport[] {
	const unique = new Map<string, ResolvedStaticImport>();
	for (const edge of state.edges) {
		const normalized: ResolvedStaticImport = {
			from: edge.from,
			specifier: edge.specifier,
			to: edge.to,
			typeOnly: edge.typeOnly,
		};
		unique.set(edgeKey(normalized), normalized);
	}
	return [...unique.values()].sort((left, right) =>
		compareStrings(edgeKey(left), edgeKey(right)),
	);
}

function validateResolvedEdges(
	state: MutableAuditState,
	observed: readonly ResolvedStaticImport[],
): void {
	const observedCounts = new Map<string, number>();
	for (const edge of state.edges) {
		const normalized: ResolvedStaticImport = {
			from: edge.from,
			specifier: edge.specifier,
			to: edge.to,
			typeOnly: edge.typeOnly,
		};
		const key = edgeKey(normalized);
		const count = (observedCounts.get(key) ?? 0) + 1;
		observedCounts.set(key, count);
		if (count === 2) {
			// edge.from is already repo-relative; prefixing TOOLS_COMPARE_ROOT
			// again produced doubled paths in the frozen inventory.
			reportFile(
				state,
				edge.from,
				"STATIC_IMPORT_DUPLICATE_OBSERVED",
				`resolved static edge occurs more than once: ${edge.specifier} -> ${edge.to}`,
			);
		}
	}
	const allowlisted = new Map<string, ResolvedStaticImport>();
	for (const edge of state.allowlist.resolvedStaticImports) {
		const normalized: ResolvedStaticImport = {
			from: edge.from,
			specifier: edge.specifier,
			to: edge.to,
			typeOnly: edge.typeOnly,
		};
		const key = edgeKey(normalized);
		if (allowlisted.has(key)) {
			reportFile(
				state,
				`${TOOLS_COMPARE_ROOT}/${ALLOWLIST_FILE}`,
				"STATIC_IMPORT_DUPLICATE",
				`resolvedStaticImports duplicates ${key}`,
			);
		}
		allowlisted.set(key, normalized);
	}
	const observedMap = new Map(observed.map((edge) => [edgeKey(edge), edge]));
	for (const edge of observed) {
		if (!allowlisted.has(edgeKey(edge))) {
			reportFile(
				state,
				`${TOOLS_COMPARE_ROOT}/${edge.from}`,
				"STATIC_IMPORT_NOT_ALLOWLISTED",
				`resolved static edge is not frozen in allowlist: ${edge.specifier} -> ${edge.to}`,
			);
		}
	}
	for (const edge of state.allowlist.resolvedStaticImports) {
		if (!observedMap.has(edgeKey(edge))) {
			reportFile(
				state,
				`${TOOLS_COMPARE_ROOT}/${edge.from}`,
				"STATIC_IMPORT_ALLOWLIST_EXTRA",
				`allowlisted static edge was not observed: ${edge.specifier} -> ${edge.to}`,
			);
		}
	}
}

function validateReachabilityClasses(state: MutableAuditState): void {
	const controllerPaths = new Set(
		state.allowlist.controllerOnlyTs.map(
			(file) => `${TOOLS_COMPARE_ROOT}/${file}`,
		),
	);
	for (const path of state.visited) {
		const repoPath = path;
		if (
			state.allowlist.fixtureTs.includes(repoPath) ||
			repoPath === "tools/compare/r1-fixtures.ts"
		) {
			reportFile(
				state,
				repoPath,
				"FIXTURE_REACHED_FROM_OFFICIAL_ROOT",
				"fixture-only code is reachable from an official child root",
			);
		}
		if (
			state.allowlist.checkerTs.includes(repoPath) ||
			repoPath === "tools/compare/check-official-io.ts"
		) {
			reportFile(
				state,
				repoPath,
				"CHECKER_REACHED_FROM_OFFICIAL_ROOT",
				"audit checker is reachable from an official child root",
			);
		}
		if (controllerPaths.has(repoPath)) {
			reportFile(
				state,
				repoPath,
				"CONTROLLER_REACHED_FROM_OFFICIAL_ROOT",
				"controller-only code is reachable from an official child root",
			);
		}
	}
}

function sortAndBoundFailures(
	failures: readonly AuditFailure[],
	maxFailures: number,
): AuditFailure[] {
	const unique = new Map<string, AuditFailure>();
	for (const failure of failures) {
		const normalized = {
			code: failure.code,
			file: normalizedRelativePath(failure.file),
			line: failure.line,
			column: failure.column,
			message: failure.message,
		};
		const key = canonicalize(normalized);
		if (!unique.has(key)) unique.set(key, normalized);
	}
	return [...unique.values()]
		.sort((left, right) =>
			compareStrings(
				canonicalize([
					left.code,
					left.file,
					left.line,
					left.column,
					left.message,
				]),
				canonicalize([
					right.code,
					right.file,
					right.line,
					right.column,
					right.message,
				]),
			),
		)
		.slice(0, maxFailures);
}

function fatalResult(
	repoRoot: string,
	message: string,
	maxFailures: number,
): OfficialIoAuditResult {
	const failures = sortAndBoundFailures(
		[
			{
				code: "CHECKER_INPUT_INVALID",
				file: repoRelative(
					repoRoot,
					resolve(repoRoot, TOOLS_COMPARE_ROOT, ALLOWLIST_FILE),
				),
				line: 1,
				column: 1,
				message,
			},
		],
		maxFailures,
	);
	return {
		schema: OFFICIAL_IO_ALLOWLIST_SCHEMA,
		status: "FAIL",
		classifiedFileSha256: canonicalSha256([]),
		resolvedGraphSha256: canonicalSha256([]),
		failureInventorySha256: canonicalSha256(failures),
		failures,
		failureCount: failures.length,
		classifiedFiles: [],
		resolvedStaticImports: [],
	};
}

function validatedMaxFailures(value: number | undefined): number | undefined {
	if (value === undefined) return MAX_FAILURES;
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > MAX_FAILURES
	) {
		return undefined;
	}
	return value;
}

export function runOfficialIoAudit(
	options: AuditOptions = {},
): OfficialIoAuditResult {
	const repoRoot = resolve(options.repoRoot ?? defaultRepoRoot());
	const maxFailures = validatedMaxFailures(options.maxFailures);
	if (maxFailures === undefined) {
		return fatalResult(
			repoRoot,
			`maxFailures must be a finite integer in the inclusive range 1..${MAX_FAILURES}`,
			MAX_FAILURES,
		);
	}
	let allowlist: OfficialIoAllowlist;
	try {
		allowlist = loadOfficialIoAllowlist(
			options.allowlistPath ??
				resolve(repoRoot, TOOLS_COMPARE_ROOT, ALLOWLIST_FILE),
			repoRoot,
		);
	} catch (error: unknown) {
		return fatalResult(
			repoRoot,
			error instanceof Error ? error.message : String(error),
			maxFailures,
		);
	}

	const state: MutableAuditState = {
		failures: [],
		sourceByPath: new Map(),
		moduleAnalysis: new Map(),
		edges: [],
		visited: new Set(),
		allowlist,
		repoRoot,
		maxFailures,
	};
	validateAllowlistShape(state, allowlist);
	const classifiedFiles = classifyFiles(state);
	validateCheckerIsolation(state);
	validateTestImports(state);
	collectGraph(state, allowlist.officialRoots);
	for (const source of state.sourceByPath.values()) {
		if (state.visited.has(source.relativePath))
			inspectSourceCalls(state, source);
	}
	// The package loader is the sole reviewed exception, but it is not a child
	// of an official comparison root.  Inspect that exact production source
	// separately so the exception cannot become a dead allowlist entry that
	// bypasses strict-mode, descriptor, or fallback checks.
	const loaderAbsolutePath = resolve(state.repoRoot, packageLoaderSource);
	if (!existsSync(loaderAbsolutePath)) {
		reportFile(
			state,
			packageLoaderSource,
			"LOADER_SOURCE_MISSING",
			"the sole package-loader exception source is missing",
		);
	} else {
		const loaderSource = parseSource(state, loaderAbsolutePath);
		if (loaderSource) {
			const loaderSources = collectLoaderGraph(state, loaderSource);
			for (const source of loaderSources) inspectSourceCalls(state, source);
		}
	}
	validateReachabilityClasses(state);
	for (const nativeSource of allowlist.nativeSources)
		inspectRustSource(state, nativeSource);
	const graph = observedEdges(state);
	validateResolvedEdges(state, graph);
	const failures = sortAndBoundFailures(state.failures, maxFailures);
	const classifiedCanonical = classifiedFiles.map((entry) => ({
		path: entry.path,
		class: entry.class,
		sha256: entry.sha256,
	}));
	return {
		schema: OFFICIAL_IO_ALLOWLIST_SCHEMA,
		status: failures.length === 0 ? "PASS" : "FAIL",
		classifiedFileSha256: canonicalSha256(classifiedCanonical),
		resolvedGraphSha256: canonicalSha256(graph),
		failureInventorySha256: canonicalSha256(failures),
		failures,
		failureCount: failures.length,
		classifiedFiles,
		resolvedStaticImports: graph,
	};
}

export const auditOfficialIo = runOfficialIoAudit;

export function formatOfficialIoAudit(result: OfficialIoAuditResult): string {
	const lines = [
		`official-io-audit/${result.schema.split("/").at(-1) ?? "v1"}`,
		`status=${result.status}`,
		`classified-file-sha256=${result.classifiedFileSha256}`,
		`resolved-graph-sha256=${result.resolvedGraphSha256}`,
		`failure-inventory-sha256=${result.failureInventorySha256}`,
		`failure-count=${result.failureCount}`,
	];
	for (const failure of result.failures) {
		lines.push(
			`failure=${failure.code}|${failure.file}|${failure.line}:${failure.column}|${failure.message}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

function runAsCli(): void {
	const result = runOfficialIoAudit();
	process.stdout.write(formatOfficialIoAudit(result));
	process.exitCode = result.status === "PASS" ? 0 : 1;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
	runAsCli();
}
