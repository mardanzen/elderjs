import path from 'path';
import fs from 'fs-extra';
import defaultsDeep from 'lodash.defaultsdeep';

import routes from './routes/routes';
import { hookInterface } from './hookInterface/hookInterface';
import internalHooks from './hooks';
import build from './build/build';
import partialHydration from './partialHydration/partialHydration';

import {
  svelteComponent,
  prepareRunHook,
  prepareServer,
  validateHook,
  validateRoute,
  validatePlugin,
  permalinks,
  getUniqueId,
  Page,
  asyncForEach,
  getHashedSvelteComponents,
  getConfig,
} from './utils';
import { RoutesOptions } from './routes/types';
import { HookOptions } from './hooks/types';
import {
  ConfigOptions,
  SettingOptions,
  QueryOptions,
  RequestOptions,
  RequestsOptions,
  PluginOptions,
  ExcludesFalse,
} from './utils/types';
import { createReadOnlyProxy } from './utils/createReadOnlyProxy';

const getElderConfig = getConfig;

class Elder {
  bootstrapComplete: Promise<any>;
  markBootstrapComplete: (Object) => void;
  settings: ConfigOptions & SettingOptions;
  routes: RoutesOptions;
  hooks: Array<HookOptions>;
  data: Object;
  runHook: (string, Object) => Promise<any>;
  hookInterface: any;
  customProps: any;

  query: QueryOptions;
  allRequests: Array<RequestOptions>;
  serverLookupObject: RequestsOptions;
  errors: any[];
  helpers: {};
  server: any;
  builder: any;

  constructor({ context }) {
    this.bootstrapComplete = new Promise((resolve) => {
      this.markBootstrapComplete = resolve;
    });

    const config = getConfig(context);

    const { srcFolder, buildFolder } = config.locations;

    this.settings = {
      ...config,
      server: context === 'server' && config[context],
      build: context === 'build' && config[context],
      $$internal: {
        hashedComponents: getHashedSvelteComponents(config),
      },
    };

    if (!context || context === 'build') {
      this.settings.debug.automagic = false;
    }

    /**
     * Plugin initalization
     * * Collect plugin routes
     * * Add plugin object and helpers to all plugin hook functions.
     */
    let pluginRoutes: RoutesOptions = {};
    const pluginHooks: Array<HookOptions> = [];
    for (const pluginName in this.settings.plugins) {
      if (Object.hasOwnProperty.call(this.settings.plugins, pluginName)) {
        const pluginConfigFromConfig = this.settings.plugins[pluginName];

        let plugin: PluginOptions | undefined;
        const pluginPath = `./plugins/${pluginName}/index.js`;
        const srcPlugin = path.resolve(process.cwd(), srcFolder, pluginPath);
        if (fs.existsSync(srcPlugin)) {
          plugin = require(srcPlugin).default || require(srcPlugin);
        }

        if (!plugin && buildFolder.length > 0) {
          const buildPlugin = path.resolve(process.cwd(), buildFolder, pluginPath);
          if (fs.existsSync(buildPlugin)) {
            plugin = require(buildPlugin).default || require(buildPlugin);
          }
        }

        if (!plugin) {
          // TODO: Test this functionality!
          const pkgPath = path.resolve(process.cwd(), './node_modules/', pluginName, './index.js');

          if (fs.existsSync(pkgPath)) {
            const pluginPackageJson = require(path.resolve(pkgPath, './package.json'));
            const pluginPath = path.resolve(pkgPath, pluginPackageJson.main);

            plugin = require(pluginPath).default || require(pluginPath);
          }
        }

        if (!plugin) {
          throw new Error(`Plugin ${pluginName} not found in plugins or node_modules folder.`);
        }

        plugin =
          plugin.init({
            ...plugin,
            config: defaultsDeep(pluginConfigFromConfig, plugin.config),
            settings: createReadOnlyProxy(this.settings, 'Settings', 'plugin init()'),
          }) || plugin;

        const validatedPlugin = validatePlugin(plugin);
        if (!validatedPlugin) return;
        plugin = validatedPlugin;

        // clean props the plugin shouldn't be able to change between hook... specifically their hooks;
        let { hooks: pluginHooksArray } = plugin;
        const { init, ...sanitizedPlugin } = plugin;

        pluginHooksArray = pluginHooksArray.map(
          (hook): HookOptions => {
            return {
              ...hook,
              $$meta: {
                type: 'plugin',
                addedBy: pluginName,
              },
              run: async (payload: any = {}) => {
                // pass the plugin definition into the closure of every hook.
                let pluginDefinition = sanitizedPlugin;

                // TODO: In a future release add in specific helpers to allow plugins to implement the
                // same hook signature as we use on plugin.helpers; Plugin defined hooks will basically "shadow"
                // system hooks.

                payload.plugin = pluginDefinition;

                const pluginResp = await hook.run(payload);
                if (pluginResp) {
                  if (pluginResp.plugin) {
                    const { plugin, ...rest } = pluginResp;
                    // while objects are pass by reference, the pattern we encourage is to return the mutation of state.
                    // if users followed this pattern for plugins, we may not be mutating the plugin definition, so this is added.
                    pluginDefinition = plugin;
                    return rest;
                  }
                  return pluginResp;
                }

                // return the hook's result.
                return {};
              },
            };
          },
        );

        pluginHooksArray.forEach((hook) => {
          const validatedHook = validateHook(hook, hookInterface);
          if (validatedHook) {
            pluginHooks.push(validatedHook);
          }
        });

        if (Object.hasOwnProperty.call(plugin, 'routes')) {
          for (const routeName in plugin.routes) {
            // don't allow plugins to add hooks via the routes definitions like users can.
            if (plugin.routes[routeName].hooks)
              console.error(
                `WARN: Plugin ${routeName} is trying to register a hooks via a the 'hooks' array on a route. This is not supported. Plugins must define the 'hooks' array at the plugin level.`,
              );
            if (!plugin.routes[routeName].data) {
              plugin.routes[routeName].data = () => ({});
            }

            if (
              typeof plugin.routes[routeName].template === 'string' &&
              plugin.routes[routeName].template.endsWith('.svelte')
            ) {
              const templateName = plugin.routes[routeName].template.replace('.svelte', '');
              const ssrComponent = path.resolve(
                process.cwd(),
                this.settings.locations.svelte.ssrComponents,
                `${templateName}.js`,
              );

              if (!fs.existsSync(ssrComponent)) {
                console.warn(
                  `Plugin Route: ${routeName} has an error. No SSR svelte compontent found ${templateName} which was added by ${pluginName}. This may cause unexpected outcomes. If you believe this should be working, make sure rollup has run before this file is initialized. If the issue persists, please contact the plugin author. Expected location \`${ssrComponent}\``,
                );
              }

              plugin.routes[routeName].templateComponent = svelteComponent(templateName);
            }

            const { hooks: pluginRouteHooks, ...sanitizedRouteDeets } = plugin.routes[routeName];
            const sanitizedRoute = {};
            sanitizedRoute[routeName] = { ...sanitizedRouteDeets, $$meta: { type: 'plugin', addedBy: pluginName } };

            pluginRoutes = { ...pluginRoutes, ...sanitizedRoute };
          }
        }
      }
    }

    // add meta to routes and collect hooks from routes
    const userRoutesJsFile = routes(this.settings);

    const routeHooks: Array<HookOptions> = [];
    for (const routeName in userRoutesJsFile) {
      if (Object.hasOwnProperty.call(userRoutesJsFile, routeName)) {
        userRoutesJsFile[routeName] = {
          ...userRoutesJsFile[routeName],
          $$meta: {
            type: 'route',
            addedBy: 'routejs',
          },
        };
        const processedRoute = userRoutesJsFile[routeName];

        if (processedRoute.hooks && Array.isArray(processedRoute.hooks)) {
          processedRoute.hooks.forEach((hook) => {
            const hookWithMeta: HookOptions = {
              ...hook,
              $$meta: {
                type: 'route',
                addedBy: routeName,
              },
            };
            routeHooks.push(hookWithMeta);
          });
        }
      }
    }

    // plugins should never overwrite user routes.
    const collectedRoutes: RoutesOptions = { ...pluginRoutes, ...userRoutesJsFile };
    const validatedRoutes = {};

    for (const collectedRouteName in collectedRoutes) {
      if ({}.hasOwnProperty.call(collectedRoutes, collectedRouteName)) {
        const collectedRoute = collectedRoutes[collectedRouteName];

        const validated = validateRoute(collectedRoute, collectedRouteName);
        if (validated) {
          validatedRoutes[collectedRouteName] = validated;
        }
      }
    }

    this.routes = validatedRoutes;

    let hooksJs: Array<HookOptions> = [];
    const hookSrcPath = path.resolve(process.cwd(), srcFolder, './hooks.js');
    const hookBuildPath = path.resolve(process.cwd(), buildFolder, './hooks.js');

    if (this.settings.debug.automagic) {
      console.log(
        `debug.automagic::Attempting to automagically pull in hooks from your ${hookSrcPath} ${
          buildFolder ? `with a fallback to ${hookBuildPath}` : ''
        }`,
      );
    }
    try {
      const hookSrcFile: Array<HookOptions> = config.typescript ? require(hookSrcPath).default : require(hookSrcPath);

      hooksJs = hookSrcFile.map((hook) => ({
        ...hook,
        $$meta: {
          type: 'hooks.js',
          addedBy: 'hooks.js',
        },
      }));
    } catch (err) {
      if (buildFolder && buildFolder.length > 0) {
        try {
          const hookBuildFile: Array<HookOptions> = config.typescript
            ? require(hookBuildPath).default
            : require(hookBuildPath);
          hooksJs = hookBuildFile.map((hook) => ({
            ...hook,
            $$meta: {
              type: 'hooks.js',
              addedBy: 'hooks.js',
            },
          }));
        } catch (err) {}
      } else {
        if (err.code === 'MODULE_NOT_FOUND') {
          if (this.settings.debug.automagic) {
            console.log(`No luck finding that hooks file. You can add one at ${hookSrcPath}`);
          }
        }
      }
    }

    const elderJsHooks: Array<HookOptions> = internalHooks.map((hook) => ({
      ...hook,
      $$meta: {
        type: 'internal',
        addedBy: 'elder.js',
      },
    }));

    const allSupportedHooks = hookInterface;

    this.hooks = [...elderJsHooks, ...pluginHooks, ...routeHooks, ...hooksJs]
      .map((hook) => validateHook(hook, hookInterface))
      .filter((Boolean as any) as ExcludesFalse);

    if (this.settings.hooks.disable && this.settings.hooks.disable.length > 0) {
      this.hooks = this.hooks.filter((h) => !this.settings.hooks.disable.includes(h.name));
    }

    // todo, plugins should be able to register their own hooks?

    this.data = {};
    this.hookInterface = allSupportedHooks;
    this.customProps = {};

    this.query = {};
    this.allRequests = [];
    this.serverLookupObject = {};
    this.errors = [];

    this.helpers = {
      permalinks: permalinks({ routes: this.routes, settings: this.settings }),
      svelteComponent,
    };

    if (context === 'server') {
      this.server = prepareServer({ bootstrapComplete: this.bootstrapComplete });
    }

    // customizeHooks should not be used by plugins. Plugins should use their own closure to manage data and be side effect free.
    const hooksMinusPlugins = this.hooks.filter((h) => h.$$meta.type !== 'plugin');
    this.runHook = prepareRunHook({
      hooks: hooksMinusPlugins,
      allSupportedHooks: this.hookInterface,
      settings: this.settings,
    });

    this.runHook('customizeHooks', this).then(async () => {
      // we now have customProps and a new hookInterface.
      this.runHook = prepareRunHook({
        hooks: this.hooks,
        allSupportedHooks: this.hookInterface,
        settings: this.settings,
      });

      await this.runHook('bootstrap', this);

      // collect all of our requests
      await asyncForEach(Object.keys(this.routes), async (routeName) => {
        const route = this.routes[routeName];
        let allRequestsForRoute = [];
        if (typeof route.all === 'function') {
          allRequestsForRoute = await route.all({
            settings: this.settings,
            query: this.query,
            helpers: this.helpers,
            data: this.data,
          });
        } else if (Array.isArray(route.all)) {
          allRequestsForRoute = route.all;
        }

        if (!Array.isArray(allRequestsForRoute)) {
          throw new Error(`${routeName}'s all() function isn't returning an array`);
        }

        allRequestsForRoute.forEach((r) => {
          r.route = routeName;
          if (!{}.hasOwnProperty.call(r, 'slug')) {
            throw new Error(`Request for ${routeName} is missing a slug property.`);
          }
        });

        this.allRequests = this.allRequests.concat(allRequestsForRoute);
      });

      await this.runHook('allRequests', this);

      await asyncForEach(this.allRequests, async (request) => {
        if (!this.routes[request.route] || !this.routes[request.route].permalink) console.log(request);
        request.type = context === 'server' ? 'server' : context === 'build' ? 'build' : 'unknown';
        request.permalink = await this.routes[request.route].permalink({
          request,
          settings: { ...this.settings },
        });

        if (this.settings && this.settings.server && this.settings.server.prefix) {
          request.permalink = this.settings.server.prefix + request.permalink;
        }

        if (context === 'server') {
          this.serverLookupObject[request.permalink] = request;
        }
      });

      if (this.allRequests.length !== new Set(this.allRequests.map((r) => r.permalink)).size) {
        // useful error logging for when there are duplicate permalinks.
        for (let i = 0, l = this.allRequests.length; i < l; i++) {
          for (let ii = 0, li = this.allRequests.length; ii < li; ii++) {
            if (i !== ii && this.allRequests[i].permalink === this.allRequests[ii].permalink) {
              throw new Error(
                `Duplicate permalinks detected. Here are the relevant requests: ${JSON.stringify(
                  this.allRequests[i],
                )} and ${JSON.stringify(this.allRequests[ii])}`,
              );
            }
          }
        }
      }

      this.markBootstrapComplete(this);
    });
  }

  cluster() {
    return this.bootstrapComplete;
  }

  worker(workerRequests) {
    return workerBuild({ bootstrapComplete: this.bootstrapComplete, workerRequests });
  }

  build() {
    return this.builder;
  }
}

async function workerBuild({ bootstrapComplete, workerRequests }) {
  const { settings, query, helpers, data, runHook, routes, errors, customProps } = await bootstrapComplete;

  // potential issue that since builds are split across processes,
  // some plugins may need all requests of the same category to be passed at the same time.

  process.send(['start', workerRequests.length]);

  let i = 0;
  let errs = 0;
  const bTimes = [];
  const bErrors = [];

  await asyncForEach(workerRequests, async (request) => {
    const page = new Page({
      allRequests: workerRequests,
      request,
      settings,
      query,
      helpers,
      data,
      route: routes[request.route],
      runHook,
      routes,
      errors,
      customProps,
    });
    const { errors: buildErrors, timings } = await page.build();
    i += 1;
    bTimes.push(timings);

    const response: any = ['html', i];
    if (buildErrors && buildErrors.length > 0) {
      errs += 1;
      response.push(errs);
      response.push({ request, errors: buildErrors });
      bErrors.push({ request, errors: buildErrors });
    } else {
      response.push(errs);
    }

    process.send(response);
  });
  return bTimes;
}

export { Elder, getElderConfig, build, partialHydration };
