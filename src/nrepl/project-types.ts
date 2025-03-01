import * as state from '../state';
import * as vscode from 'vscode';
import * as path from 'path';
import * as getPort from 'get-port';
import * as utilities from '../utilities';
import * as pprint from '../printer';
import { getConfig } from '../config';
import { keywordize, unKeywordize } from '../util/string';
import { CljsTypes, ReplConnectSequence } from './connectSequence';
import { parseForms, parseEdn } from '../../out/cljs-lib/cljs-lib';

export const isWin = /^win/.test(process.platform);

export type ProjectType = {
  name: string;
  cljsTypes: string[];
  cmd: string[];
  winCmd: string[];
  resolveBundledPathWin?: () => string;
  resolveBundledPathUnix?: () => string;
  processShellWin: boolean;
  processShellUnix: boolean;
  commandLine: (connectSequence: ReplConnectSequence, cljsType: CljsTypes) => any;
  useWhenExists: string;
  nReplPortFile: string[];
};

function nreplPortFileRelativePath(connectSequence: ReplConnectSequence): string {
  let subPath: string;
  if (connectSequence.nReplPortFile) {
    subPath = path.join(...connectSequence.nReplPortFile);
  } else {
    const projectType: ProjectType | string = connectSequence.projectType;
    subPath = path.join(...getProjectTypeForName(projectType).nReplPortFile);
  }
  return subPath;
}

/**
 * If you know that you're using the local machine to access the nREPL port file,
 * you can use this method. It returns an absolute path to the right file. In case
 * you may be dealing with a remote scenario (e.g. live share), you should use
 * `nreplPortFileUri()` instead.
 */
export function nreplPortFileLocalPath(connectSequence: ReplConnectSequence): string {
  const relativePath = nreplPortFileRelativePath(connectSequence);
  const projectRoot = state.getProjectRootLocal();
  if (projectRoot) {
    try {
      return path.resolve(projectRoot, relativePath);
    } catch (e) {
      console.log(e);
    }
  }
  return relativePath;
}

export function nreplPortFileUri(connectSequence: ReplConnectSequence): vscode.Uri {
  const relativePath = nreplPortFileRelativePath(connectSequence);
  const projectRoot = state.getProjectRootUri();
  if (projectRoot) {
    try {
      return vscode.Uri.joinPath(projectRoot, relativePath);
    } catch (e) {
      return vscode.Uri.file(path.join(projectRoot.fsPath, relativePath));
    }
  }
  return vscode.Uri.file(relativePath);
}

export function shadowConfigFile(): vscode.Uri {
  return vscode.Uri.joinPath(state.getProjectRootUri(), 'shadow-cljs.edn');
}

export async function shadowBuilds(): Promise<string[]> {
  const data = await vscode.workspace.fs.readFile(shadowConfigFile());
  const parsed = parseEdn(new TextDecoder('utf-8').decode(data));
  return [
    ...(parsed.builds
      ? Object.keys(parsed.builds).map((key: string) => {
          return ':' + key;
        })
      : []),
    ...['node-repl', 'browser-repl'],
  ];
}

export function leinShadowBuilds(defproject: any): string[] {
  if (defproject) {
    const shadowIndex = defproject.indexOf('shadow-cljs');
    if (shadowIndex > -1) {
      const buildsMap = defproject[shadowIndex + 1];
      try {
        return [
          ...Object.keys(buildsMap.builds).map((k, v) => {
            return ':' + k;
          }),
          ...['node-repl', 'browser-repl'],
        ];
      } catch (error) {
        void vscode.window.showErrorMessage('The project.clj file is not sane. ' + error.message);
        console.log(error);
      }
      return [];
    }
  }
}

async function selectShadowBuilds(
  connectSequence: ReplConnectSequence,
  foundBuilds: string[]
): Promise<{ selectedBuilds: string[]; args: string[] }> {
  const menuSelections = connectSequence.menuSelections,
    selectedBuilds = menuSelections
      ? menuSelections.cljsLaunchBuilds
      : await utilities.quickPickMulti({
          values: foundBuilds.filter((x) => x[0] == ':'),
          placeHolder: 'Select builds to start',
          saveAs: `${state.getProjectRootUri().toString()}/shadow-cljs-jack-in`,
        }),
    aliases: string[] =
      menuSelections && menuSelections.cljAliases ? menuSelections.cljAliases.map(keywordize) : []; // TODO do the same as clj to prompt the user with a list of aliases
  const aliasesOption = aliases.length > 0 ? `-A${aliases.join('')}` : '';
  const args: string[] = [];
  if (aliasesOption && aliasesOption.length) {
    args.push(aliasesOption);
  }
  return { selectedBuilds, args };
}

async function leinDefProject(): Promise<any> {
  const bytes = await vscode.workspace.fs.readFile(
    vscode.Uri.joinPath(state.getProjectRootUri(), 'project.clj')
  );
  const data = new TextDecoder('utf-8').decode(bytes);
  try {
    const parsed = parseForms(data);
    return parsed.find((x) => x[0] == 'defproject');
  } catch (e) {
    void vscode.window.showErrorMessage('Could not parse project.clj');
    throw e;
  }
}

async function leinProfilesAndAlias(
  defproject: any,
  connectSequence: ReplConnectSequence
): Promise<{ profiles: string[]; alias: string }> {
  let profiles: string[] = [],
    alias: string;

  if (defproject) {
    const aliasesIndex = defproject.indexOf('aliases');
    if (aliasesIndex > -1) {
      try {
        const menuSelections = connectSequence.menuSelections,
          leinAlias = menuSelections ? menuSelections.leinAlias : undefined;
        if (leinAlias) {
          alias = unKeywordize(leinAlias);
        } else if (leinAlias === null) {
          alias = undefined;
        } else {
          let aliases: string[] = [];
          const aliasesMap = defproject[aliasesIndex + 1];
          aliases = Object.keys(aliasesMap).map((v, k) => v);
          if (aliases.length) {
            aliases.unshift('No alias');
            alias = await utilities.quickPickSingle({
              values: aliases,
              saveAs: `${state.getProjectRootUri().toString()}/lein-cli-alias`,
              placeHolder: 'Choose alias to launch with',
            });
            alias = alias == 'No alias' ? undefined : alias;
          }
        }
      } catch (error) {
        void vscode.window.showErrorMessage('The project.clj file is not sane. ' + error.message);
        console.log(error);
      }
    }

    const profilesIndex = defproject.indexOf('profiles'),
      menuSelections = connectSequence.menuSelections,
      launchProfiles = menuSelections ? menuSelections.leinProfiles : undefined;
    if (launchProfiles) {
      profiles = launchProfiles.map(keywordize);
    } else {
      let projectProfiles = profilesIndex > -1 ? Object.keys(defproject[profilesIndex + 1]) : [];
      const myProfiles = getConfig().myLeinProfiles;
      if (myProfiles && myProfiles.length) {
        projectProfiles = [...projectProfiles, ...myProfiles];
      }
      if (projectProfiles.length) {
        profiles = projectProfiles.map(keywordize);
        if (profiles.length) {
          profiles = await utilities.quickPickMulti({
            values: profiles,
            saveAs: `${state.getProjectRootUri().toString()}/lein-cli-profiles`,
            placeHolder: 'Pick any profiles to launch with',
          });
        }
      }
    }
  }
  return { profiles, alias };
}

export enum JackInDependency {
  'nrepl' = 'nrepl',
  'cider-nrepl' = 'cider-nrepl',
  'cider/piggieback' = 'cider/piggieback',
}

const NREPL_VERSION = () => getConfig().jackInDependencyVersions['nrepl'],
  CIDER_NREPL_VERSION = () => getConfig().jackInDependencyVersions['cider-nrepl'],
  PIGGIEBACK_VERSION = () => getConfig().jackInDependencyVersions['cider/piggieback'];

const cliDependencies = () => {
  return {
    'nrepl/nrepl': NREPL_VERSION(),
    'cider/cider-nrepl': CIDER_NREPL_VERSION(),
  };
};

const cljsDependencies = () => {
  return {
    'lein-figwheel': {
      'cider/piggieback': PIGGIEBACK_VERSION(),
    },
    'Figwheel Main': {
      'cider/piggieback': PIGGIEBACK_VERSION(),
    },
    'shadow-cljs': {
      'cider/cider-nrepl': CIDER_NREPL_VERSION(),
    },
    'lein-shadow': {
      'cider/cider-nrepl': CIDER_NREPL_VERSION(),
    },
    'ClojureScript built-in for browser': {
      'cider/piggieback': PIGGIEBACK_VERSION(),
    },
    'ClojureScript built-in for node': {
      'cider/piggieback': PIGGIEBACK_VERSION(),
    },
    'User provided': {
      'cider/piggieback': PIGGIEBACK_VERSION(),
    },
  };
};

const leinPluginDependencies = () => {
  return {
    'cider/cider-nrepl': CIDER_NREPL_VERSION(),
  };
};
const leinDependencies = () => {
  return {
    nrepl: NREPL_VERSION(),
  };
};
const middleware = ['cider.nrepl/cider-middleware'];
const cljsMiddlewareNames = {
  wrapCljsRepl: 'cider.piggieback/wrap-cljs-repl',
};
const cljsMiddleware: { [id: string]: string[] } = {
  'lein-figwheel': [cljsMiddlewareNames.wrapCljsRepl],
  'Figwheel Main': [cljsMiddlewareNames.wrapCljsRepl],
  'shadow-cljs': [],
  'lein-shadow': [cljsMiddlewareNames.wrapCljsRepl],
  'ClojureScript built-in for browser': [cljsMiddlewareNames.wrapCljsRepl],
  'ClojureScript built-in for node': [cljsMiddlewareNames.wrapCljsRepl],
  'User provided': [cljsMiddlewareNames.wrapCljsRepl],
  none: [],
};

const serverPrinterDependencies = pprint.getServerSidePrinterDependencies();

function depsCljWindowsPath() {
  return `"${path.join('.', '.calva', 'deps.clj.jar')}"`;
}

const projectTypes: { [id: string]: ProjectType } = {
  lein: {
    name: 'Leiningen',
    cljsTypes: [
      'Figwheel',
      'Figwheel Main',
      'ClojureScript built-in for browser',
      'ClojureScript built-in for node',
    ],
    cmd: ['lein'],
    winCmd: ['cmd.exe', '/d', '/c', 'lein'],
    processShellUnix: true,
    processShellWin: false,
    useWhenExists: 'project.clj',
    nReplPortFile: ['.nrepl-port'],
    /** Build the command line args for a lein-project.
     * 1. Parsing the project.clj
     * 2. Let the user choose a alias
     * 3. Let the user choose profiles to use
     * 4. Add needed middleware deps to args
     * 5. Add all profiles chosen by the user
     * 6. Use alias if selected otherwise repl :headless
     */
    commandLine: async (connectSequence: ReplConnectSequence, cljsType: CljsTypes) => {
      return await leinCommandLine(['repl', ':headless'], cljsType, connectSequence);
    },
  },
  clj: {
    name: 'deps.edn',
    cljsTypes: [
      'Figwheel',
      'Figwheel Main',
      'ClojureScript built-in for browser',
      'ClojureScript built-in for node',
    ],
    cmd: ['clojure'],
    winCmd: ['java', '-jar'],
    resolveBundledPathWin: depsCljWindowsPath,
    processShellUnix: true,
    processShellWin: true,
    useWhenExists: 'deps.edn',
    nReplPortFile: ['.nrepl-port'],
    /** Build the command line args for a clj-project.
     * 1. Read the deps.edn and parsed it
     * 2. Present the user all found aliases
     * 3. Define needed dependencies and middlewares used by calva
     * 4. Check if the selected aliases have main-opts
     * 5. If main-opts in alias => just use aliases
     * 6. if no main-opts => supply our own main to run nrepl with middlewares
     */
    commandLine: async (connectSequence, cljsType) => {
      return cljCommandLine(connectSequence, cljsType);
    },
  },
  'shadow-cljs': {
    name: 'shadow-cljs',
    cljsTypes: [],
    cmd: ['npx'],
    winCmd: ['npx.cmd'],
    processShellUnix: true,
    processShellWin: false,
    useWhenExists: 'shadow-cljs.edn',
    nReplPortFile: ['.shadow-cljs', 'nrepl.port'],
    /**
     *  Build the command line args for a shadow-project.
     */
    commandLine: async (connectSequence, cljsType) => {
      const chan = state.outputChannel(),
        dependencies = {
          ...(cljsType ? { ...cljsDependencies()[cljsType] } : {}),
          ...serverPrinterDependencies,
        };
      const defaultArgs: string[] = [];
      for (const dep in dependencies) {
        defaultArgs.push('-d', dep + ':' + dependencies[dep]);
      }

      const foundBuilds = await shadowBuilds();
      const { selectedBuilds, args } =
        foundBuilds.length > 2
          ? await selectShadowBuilds(connectSequence, foundBuilds)
          : { selectedBuilds: undefined, args: [] };

      return [
        'shadow-cljs',
        ...defaultArgs,
        ...args,
        ...(selectedBuilds ? ['watch', ...selectedBuilds] : ['server']),
      ];
    },
  },
  'lein-shadow': {
    name: 'lein-shadow',
    cljsTypes: [],
    cmd: ['lein'],
    winCmd: ['cmd.exe', '/d', '/c', 'lein'],
    processShellUnix: true,
    processShellWin: false,
    useWhenExists: 'project.clj',
    nReplPortFile: ['.shadow-cljs', 'nrepl.port'],
    /**
     *  Build the command line args for a lein-shadow project.
     */
    commandLine: async (connectSequence, cljsType) => {
      const chan = state.outputChannel();

      const defproject = await leinDefProject();
      const foundBuilds = leinShadowBuilds(defproject),
        { selectedBuilds, args: extraArgs } = await selectShadowBuilds(
          connectSequence,
          foundBuilds
        );

      if (selectedBuilds && selectedBuilds.length) {
        return leinCommandLine(['shadow', 'watch', ...selectedBuilds], cljsType, connectSequence);
      } else {
        chan.show();
        chan.appendLine('Aborting. No valid shadow-cljs build selected.');
        throw 'No shadow-cljs build selected';
      }
    },
  },
  generic: {
    name: 'generic',
    cljsTypes: [],
    cmd: ['java', '-jar'],
    winCmd: ['java', '-jar'],
    resolveBundledPathWin: depsCljWindowsPath,
    resolveBundledPathUnix: () =>
      `'${path.join(state.extensionContext.extensionPath, 'deps.clj.jar')}'`,
    processShellUnix: true,
    processShellWin: true,
    useWhenExists: undefined,
    nReplPortFile: ['.nrepl-port'],
    commandLine: async (connectSequence: ReplConnectSequence, cljsType: CljsTypes) => {
      return cljCommandLine(connectSequence, CljsTypes.none);
    },
  },
  babashka: {
    name: 'babashka',
    cljsTypes: [],
    cmd: ['bb'],
    winCmd: ['bb'],
    processShellUnix: true,
    processShellWin: true,
    useWhenExists: undefined,
    nReplPortFile: ['.bb-nrepl-port'],
    commandLine: async (_connectSequence: ReplConnectSequence, _cljsType: CljsTypes) => {
      return ['--nrepl-server', await getPort()];
    },
  },
  nbb: {
    name: 'nbb',
    cljsTypes: [],
    cmd: ['npx'],
    winCmd: ['npx.cmd'],
    processShellUnix: true,
    processShellWin: true,
    useWhenExists: undefined,
    nReplPortFile: ['.nbb-nrepl-port'],
    commandLine: async (_connectSequence: ReplConnectSequence, _cljsType: CljsTypes) => {
      return ['nbb', 'nrepl-server', ':port', await getPort()];
    },
  },
};

async function cljCommandLine(connectSequence: ReplConnectSequence, cljsType: CljsTypes) {
  const out: string[] = [];
  let depsUri: vscode.Uri;
  try {
    depsUri = vscode.Uri.joinPath(state.getProjectRootUri(), 'deps.edn');
  } catch {
    depsUri = vscode.Uri.file(path.join(state.getProjectRootUri().fsPath, 'deps.edn'));
  }
  let parsed;
  if (connectSequence.projectType !== 'generic') {
    void vscode.workspace.fs.stat(depsUri);
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(state.getProjectRootUri(), 'deps.edn')
    );
    const data = new TextDecoder('utf-8').decode(bytes);
    try {
      parsed = parseEdn(data);
    } catch (e) {
      void vscode.window.showErrorMessage('Could not parse deps.edn');
      throw e;
    }
  }
  const menuSelections = connectSequence.menuSelections;

  const launchAliases = menuSelections ? menuSelections.cljAliases : undefined;
  let aliases: string[] = [];
  const aliasesWithMain: string[] = [];
  if (launchAliases) {
    aliases = launchAliases.map(keywordize);
  } else {
    let projectAliases = parsed && parsed.aliases != undefined ? Object.keys(parsed.aliases) : [];
    for (const projectAlias of projectAliases) {
      const aliasKey = unKeywordize(projectAlias);
      if (parsed && parsed.aliases) {
        const alias = parsed.aliases[aliasKey];
        if (alias && alias['main-opts'] != undefined) {
          aliasesWithMain.push(`:${projectAlias}`);
        }
      }
    }
    if (aliasesWithMain.length > 0) {
      const alertKey = 'calva.jackInMainOptsWarningEnabled';
      if (state.extensionContext.workspaceState.get(alertKey, true)) {
        void vscode.window
          .showInformationMessage(
            `The aliases [${aliasesWithMain.join(
              ' '
            )}] specify :main-opts. Unless the options start an nREPL server, Jack-in will not work with such an alias selected.`,
            "OK, Don't show again",
            'OK'
          )
          .then((answer) => {
            if (answer === "OK, Don't show again") {
              void state.extensionContext.workspaceState.update(alertKey, false);
            }
          });
      }
    }
    const myAliases = getConfig().myCljAliases;
    if (myAliases && myAliases.length) {
      projectAliases = [...projectAliases, ...myAliases];
    }
    if (projectAliases.length) {
      aliases = await utilities.quickPickMulti({
        values: projectAliases.map(keywordize),
        saveAs: `${state.getProjectRootUri().toString()}/clj-cli-aliases`,
        placeHolder: 'Pick any aliases to launch with',
      });
    }
  }
  const selectedAliasesHasMain = aliases.filter((a) => aliasesWithMain.includes(a)).length > 0;

  const dependencies = {
    ...cliDependencies(),
    ...(cljsType ? { ...cljsDependencies()[cljsType] } : {}),
    ...serverPrinterDependencies,
  };
  const useMiddleware = [...middleware, ...(cljsType ? cljsMiddleware[cljsType] : [])];

  const aliasesFlag = getConfig().jackIn.useDeprecatedAliasFlag ? ['-A', ''] : ['-M', '-M'];
  const aliasesOption =
    aliases.length > 0 ? `${aliasesFlag[0]}${aliases.join('')}` : aliasesFlag[1];
  const q = isWin ? '"' : "'";
  const dQ = isWin ? '""' : '"';
  for (const dep in dependencies) {
    out.push(dep + ` {:mvn/version,${dQ}${dependencies[dep]}${dQ}}`);
  }

  const args = ['-Sdeps', `${q}${'{:deps {' + out.join(',') + '}}'}${q}`];

  if (selectedAliasesHasMain) {
    args.push(aliasesOption);
  } else {
    args.push(
      aliasesOption,
      '-m',
      'nrepl.cmdline',
      '--middleware',
      `"[${useMiddleware.join(' ')}]"`
    );
  }

  return args;
}

async function leinCommandLine(
  command: string[],
  cljsType: CljsTypes,
  connectSequence: ReplConnectSequence
) {
  const out: string[] = [];
  const dependencies = {
    ...leinDependencies(),
    ...(cljsType ? { ...cljsDependencies()[cljsType] } : {}),
    ...serverPrinterDependencies,
  };
  let keys = Object.keys(dependencies);
  const defproject = await leinDefProject();
  const { profiles, alias } = await leinProfilesAndAlias(defproject, connectSequence);
  const q = isWin ? '' : "'",
    dQ = '"';
  for (let i = 0; i < keys.length; i++) {
    const dep = keys[i];
    out.push(
      'update-in',
      ':dependencies',
      'conj',
      `${q + '[' + dep + ',' + dQ + dependencies[dep] + dQ + ']' + q}`,
      '--'
    );
  }
  keys = Object.keys(leinPluginDependencies());
  for (let i = 0; i < keys.length; i++) {
    const dep = keys[i];
    out.push(
      'update-in',
      ':plugins',
      'conj',
      `${q + '[' + dep + ',' + dQ + leinPluginDependencies()[dep] + dQ + ']' + q}`,
      '--'
    );
  }
  const useMiddleware = [...middleware, ...(cljsType ? cljsMiddleware[cljsType] : [])];
  for (const mw of useMiddleware) {
    out.push(
      'update-in',
      `${q + '[:repl-options,:nrepl-middleware]' + q}`,
      'conj',
      `'["${mw}"]'`,
      '--'
    );
  }
  if (profiles.length) {
    out.push('with-profile', profiles.map((x) => `+${unKeywordize(x)}`).join(','));
  }

  out.push(...command);

  return out;
}

/** Given the name of a project in project types, find that project. */
export function getProjectTypeForName(name: string) {
  for (const id in projectTypes) {
    if (projectTypes[id].name == name) {
      return projectTypes[id];
    }
  }
}

export async function detectProjectTypes(): Promise<string[]> {
  const rootUri = state.getProjectRootUri();
  const cljProjTypes = ['generic', 'cljs-only', 'babashka', 'nbb', 'joyride'];
  for (const clj in projectTypes) {
    if (projectTypes[clj].useWhenExists) {
      try {
        const projectFileName = projectTypes[clj].useWhenExists;
        const uri = vscode.Uri.joinPath(rootUri, projectFileName);
        await vscode.workspace.fs.readFile(uri);
        cljProjTypes.push(clj);
      } catch {
        // continue regardless of error
      }
    }
  }
  return cljProjTypes;
}

export function getAllProjectTypes(): string[] {
  return [
    'generic',
    'cljs-only',
    ...Object.keys(projectTypes).filter((pt) => !['generic', 'cljs-only'].includes(pt)),
  ];
}

export function getCljsTypeName(connectSequence: ReplConnectSequence) {
  let cljsTypeName: string;
  if (connectSequence.cljsType == undefined) {
    cljsTypeName = '';
  } else if (typeof connectSequence.cljsType == 'string') {
    cljsTypeName = connectSequence.cljsType;
  } else if (connectSequence.cljsType.dependsOn != undefined) {
    cljsTypeName = connectSequence.cljsType.dependsOn;
  } else {
    cljsTypeName = 'custom';
  }
  return cljsTypeName;
}
