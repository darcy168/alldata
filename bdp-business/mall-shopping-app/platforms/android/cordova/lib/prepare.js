/**
    Licensed to the Apache Software Foundation (ASF) under one
    or more contributor license agreements.  See the NOTICE file
    distributed with this work for additional information
    regarding copyright ownership.  The ASF licenses this file
    to you under the Apache License, Version 2.0 (the
    "License"); you may not use this file except in compliance
    with the License.  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing,
    software distributed under the License is distributed on an
    "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
    KIND, either express or implied.  See the License for the
    specific language governing permissions and limitations
    under the License.
*/
/* eslint no-useless-escape: 0 */

var Q = require('q');
var fs = require('fs');
var path = require('path');
var shell = require('shelljs');
var events = require('cordova-common').events;
var AndroidManifest = require('./AndroidManifest');
var checkReqs = require('./check_reqs');
var xmlHelpers = require('cordova-common').xmlHelpers;
var CordovaError = require('cordova-common').CordovaError;
var ConfigParser = require('cordova-common').ConfigParser;
var FileUpdater = require('cordova-common').FileUpdater;
var PlatformJson = require('cordova-common').PlatformJson;
var PlatformMunger = require('cordova-common').ConfigChanges.PlatformMunger;
var PluginInfoProvider = require('cordova-common').PluginInfoProvider;

module.exports.prepare = function (cordovaProject, options) {
    var self = this;

    var platformJson = PlatformJson.load(this.locations.root, this.platform);
    var munger = new PlatformMunger(this.platform, this.locations.root, platformJson, new PluginInfoProvider());

    this._config = updateConfigFilesFrom(cordovaProject.projectConfig, munger, this.locations);

    // Update own www dir with project's www assets and plugins' assets and js-files
    return Q.when(updateWww(cordovaProject, this.locations)).then(function () {
        // update project according to config.xml changes.
        return updateProjectAccordingTo(self._config, self.locations);
    }).then(function () {
        updateIcons(cordovaProject, path.relative(cordovaProject.root, self.locations.res));
        updateSplashes(cordovaProject, path.relative(cordovaProject.root, self.locations.res));
        updateFileResources(cordovaProject, path.relative(cordovaProject.root, self.locations.root));
    }).then(function () {
        events.emit('verbose', 'Prepared android project successfully');
    });
};

module.exports.clean = function (options) {
    // A cordovaProject isn't passed into the clean() function, because it might have
    // been called from the platform shell script rather than the CLI. Check for the
    // noPrepare option passed in by the non-CLI clean script. If that's present, or if
    // there's no config.xml found at the project root, then don't clean prepared files.
    var projectRoot = path.resolve(this.root, '../..');
    if ((options && options.noPrepare) || !fs.existsSync(this.locations.configXml) ||
            !fs.existsSync(this.locations.configXml)) {
        return Q();
    }

    var projectConfig = new ConfigParser(this.locations.configXml);

    var self = this;
    return Q().then(function () {
        cleanWww(projectRoot, self.locations);
        cleanIcons(projectRoot, projectConfig, path.relative(projectRoot, self.locations.res));
        cleanSplashes(projectRoot, projectConfig, path.relative(projectRoot, self.locations.res));
        cleanFileResources(projectRoot, projectConfig, path.relative(projectRoot, self.locations.root));
    });
};

/**
 * Updates config files in project based on app's config.xml and config munge,
 *   generated by plugins.
 *
 * @param   {ConfigParser}   sourceConfig  A project's configuration that will
 *   be merged into platform's config.xml
 * @param   {ConfigChanges}  configMunger  An initialized ConfigChanges instance
 *   for this platform.
 * @param   {Object}         locations     A map of locations for this platform
 *
 * @return  {ConfigParser}                 An instance of ConfigParser, that
 *   represents current project's configuration. When returned, the
 *   configuration is already dumped to appropriate config.xml file.
 */
function updateConfigFilesFrom (sourceConfig, configMunger, locations) {
    events.emit('verbose', 'Generating platform-specific config.xml from defaults for android at ' + locations.configXml);

    // First cleanup current config and merge project's one into own
    // Overwrite platform config.xml with defaults.xml.
    shell.cp('-f', locations.defaultConfigXml, locations.configXml);

    // Then apply config changes from global munge to all config files
    // in project (including project's config)
    configMunger.reapply_global_munge().save_all();

    events.emit('verbose', 'Merging project\'s config.xml into platform-specific android config.xml');
    // Merge changes from app's config.xml into platform's one
    var config = new ConfigParser(locations.configXml);
    xmlHelpers.mergeXml(sourceConfig.doc.getroot(),
        config.doc.getroot(), 'android', /* clobber= */true);

    config.write();
    return config;
}

/**
 * Logs all file operations via the verbose event stream, indented.
 */
function logFileOp (message) {
    events.emit('verbose', '  ' + message);
}

/**
 * Updates platform 'www' directory by replacing it with contents of
 *   'platform_www' and app www. Also copies project's overrides' folder into
 *   the platform 'www' folder
 *
 * @param   {Object}  cordovaProject    An object which describes cordova project.
 * @param   {Object}  destinations      An object that contains destination
 *   paths for www files.
 */
function updateWww (cordovaProject, destinations) {
    var sourceDirs = [
        path.relative(cordovaProject.root, cordovaProject.locations.www),
        path.relative(cordovaProject.root, destinations.platformWww)
    ];

    // If project contains 'merges' for our platform, use them as another overrides
    var merges_path = path.join(cordovaProject.root, 'merges', 'android');
    if (fs.existsSync(merges_path)) {
        events.emit('verbose', 'Found "merges/android" folder. Copying its contents into the android project.');
        sourceDirs.push(path.join('merges', 'android'));
    }

    var targetDir = path.relative(cordovaProject.root, destinations.www);
    events.emit(
        'verbose', 'Merging and updating files from [' + sourceDirs.join(', ') + '] to ' + targetDir);
    FileUpdater.mergeAndUpdateDir(
        sourceDirs, targetDir, { rootDir: cordovaProject.root }, logFileOp);
}

/**
 * Cleans all files from the platform 'www' directory.
 */
function cleanWww (projectRoot, locations) {
    var targetDir = path.relative(projectRoot, locations.www);
    events.emit('verbose', 'Cleaning ' + targetDir);

    // No source paths are specified, so mergeAndUpdateDir() will clear the target directory.
    FileUpdater.mergeAndUpdateDir(
        [], targetDir, { rootDir: projectRoot, all: true }, logFileOp);
}

/**
 * Updates project structure and AndroidManifest according to project's configuration.
 *
 * @param   {ConfigParser}  platformConfig  A project's configuration that will
 *   be used to update project
 * @param   {Object}  locations       A map of locations for this platform
 */
function updateProjectAccordingTo (platformConfig, locations) {
    // Update app name by editing res/values/strings.xml
    var strings = xmlHelpers.parseElementtreeSync(locations.strings);

    var name = platformConfig.name();
    strings.find('string[@name="app_name"]').text = name.replace(/\'/g, '\\\'');

    var shortName = platformConfig.shortName && platformConfig.shortName();
    if (shortName && shortName !== name) {
        strings.find('string[@name="launcher_name"]').text = shortName.replace(/\'/g, '\\\'');
    }

    fs.writeFileSync(locations.strings, strings.write({indent: 4}), 'utf-8');
    events.emit('verbose', 'Wrote out android application name "' + name + '" to ' + locations.strings);

    // Java packages cannot support dashes
    var androidPkgName = (platformConfig.android_packageName() || platformConfig.packageName()).replace(/-/g, '_');

    var manifest = new AndroidManifest(locations.manifest);
    var manifestId = manifest.getPackageId();

    manifest.getActivity()
        .setOrientation(platformConfig.getPreference('orientation'))
        .setLaunchMode(findAndroidLaunchModePreference(platformConfig));

    manifest.setVersionName(platformConfig.version())
        .setVersionCode(platformConfig.android_versionCode() || default_versionCode(platformConfig.version()))
        .setPackageId(androidPkgName)
        .setMinSdkVersion(platformConfig.getPreference('android-minSdkVersion', 'android'))
        .setMaxSdkVersion(platformConfig.getPreference('android-maxSdkVersion', 'android'))
        .setTargetSdkVersion(platformConfig.getPreference('android-targetSdkVersion', 'android'))
        .write();

    var javaPattern = path.join(locations.root, 'src', manifestId.replace(/\./g, '/'), '*.java');
    var java_files = shell.ls(javaPattern).filter(function (f) {
        return shell.grep(/extends\s+CordovaActivity/g, f);
    });

    if (java_files.length === 0) {
        throw new CordovaError('No Java files found that extend CordovaActivity.');
    } else if (java_files.length > 1) {
        events.emit('log', 'Multiple candidate Java files that extend CordovaActivity found. Guessing at the first one, ' + java_files[0]);
    }

    var destFile = path.join(locations.root, 'src', androidPkgName.replace(/\./g, '/'), path.basename(java_files[0]));
    shell.mkdir('-p', path.dirname(destFile));
    shell.sed(/package [\w\.]*;/, 'package ' + androidPkgName + ';', java_files[0]).to(destFile);
    events.emit('verbose', 'Wrote out Android package name "' + androidPkgName + '" to ' + destFile);

    var removeOrigPkg = checkReqs.isWindows() || checkReqs.isDarwin() ?
        manifestId.toUpperCase() !== androidPkgName.toUpperCase() :
        manifestId !== androidPkgName;

    if (removeOrigPkg) {
        // If package was name changed we need to remove old java with main activity
        shell.rm('-Rf', java_files[0]);
        // remove any empty directories
        var currentDir = path.dirname(java_files[0]);
        var sourcesRoot = path.resolve(locations.root, 'src');
        while (currentDir !== sourcesRoot) {
            if (fs.existsSync(currentDir) && fs.readdirSync(currentDir).length === 0) {
                fs.rmdirSync(currentDir);
                currentDir = path.resolve(currentDir, '..');
            } else {
                break;
            }
        }
    }
}

// Consturct the default value for versionCode as
// PATCH + MINOR * 100 + MAJOR * 10000
// see http://developer.android.com/tools/publishing/versioning.html
function default_versionCode (version) {
    var nums = version.split('-')[0].split('.');
    var versionCode = 0;
    if (+nums[0]) {
        versionCode += +nums[0] * 10000;
    }
    if (+nums[1]) {
        versionCode += +nums[1] * 100;
    }
    if (+nums[2]) {
        versionCode += +nums[2];
    }

    events.emit('verbose', 'android-versionCode not found in config.xml. Generating a code based on version in config.xml (' + version + '): ' + versionCode);
    return versionCode;
}

function getImageResourcePath (resourcesDir, type, density, name, sourceName) {
    if (/\.9\.png$/.test(sourceName)) {
        name = name.replace(/\.png$/, '.9.png');
    }
    var resourcePath = path.join(resourcesDir, (density ? type + '-' + density : type), name);
    return resourcePath;
}

function updateSplashes (cordovaProject, platformResourcesDir) {
    var resources = cordovaProject.projectConfig.getSplashScreens('android');

    // if there are "splash" elements in config.xml
    if (resources.length === 0) {
        events.emit('verbose', 'This app does not have splash screens defined');
        return;
    }

    var resourceMap = mapImageResources(cordovaProject.root, platformResourcesDir, 'drawable', 'screen.png');

    var hadMdpi = false;
    resources.forEach(function (resource) {
        if (!resource.density) {
            return;
        }
        if (resource.density === 'mdpi') {
            hadMdpi = true;
        }
        var targetPath = getImageResourcePath(
            platformResourcesDir, 'drawable', resource.density, 'screen.png', path.basename(resource.src));
        resourceMap[targetPath] = resource.src;
    });

    // There's no "default" drawable, so assume default == mdpi.
    if (!hadMdpi && resources.defaultResource) {
        var targetPath = getImageResourcePath(
            platformResourcesDir, 'drawable', 'mdpi', 'screen.png', path.basename(resources.defaultResource.src));
        resourceMap[targetPath] = resources.defaultResource.src;
    }

    events.emit('verbose', 'Updating splash screens at ' + platformResourcesDir);
    FileUpdater.updatePaths(
        resourceMap, { rootDir: cordovaProject.root }, logFileOp);
}

function cleanSplashes (projectRoot, projectConfig, platformResourcesDir) {
    var resources = projectConfig.getSplashScreens('android');
    if (resources.length > 0) {
        var resourceMap = mapImageResources(projectRoot, platformResourcesDir, 'drawable', 'screen.png');
        events.emit('verbose', 'Cleaning splash screens at ' + platformResourcesDir);

        // No source paths are specified in the map, so updatePaths() will delete the target files.
        FileUpdater.updatePaths(
            resourceMap, { rootDir: projectRoot, all: true }, logFileOp);
    }
}

function updateIcons (cordovaProject, platformResourcesDir) {
    var icons = cordovaProject.projectConfig.getIcons('android');

    // if there are icon elements in config.xml
    if (icons.length === 0) {
        events.emit('verbose', 'This app does not have launcher icons defined');
        return;
    }

    var resourceMap = mapImageResources(cordovaProject.root, platformResourcesDir, 'mipmap', 'icon.png');

    var android_icons = {};
    var default_icon;
    // http://developer.android.com/design/style/iconography.html
    var sizeToDensityMap = {
        36: 'ldpi',
        48: 'mdpi',
        72: 'hdpi',
        96: 'xhdpi',
        144: 'xxhdpi',
        192: 'xxxhdpi'
    };
    // find the best matching icon for a given density or size
    // @output android_icons
    var parseIcon = function (icon, icon_size) {
        // do I have a platform icon for that density already
        var density = icon.density || sizeToDensityMap[icon_size];
        if (!density) {
            // invalid icon defition ( or unsupported size)
            return;
        }
        var previous = android_icons[density];
        if (previous && previous.platform) {
            return;
        }
        android_icons[density] = icon;
    };

    // iterate over all icon elements to find the default icon and call parseIcon
    for (var i = 0; i < icons.length; i++) {
        var icon = icons[i];
        var size = icon.width;
        if (!size) {
            size = icon.height;
        }
        if (!size && !icon.density) {
            if (default_icon) {
                events.emit('verbose', 'Found extra default icon: ' + icon.src + ' (ignoring in favor of ' + default_icon.src + ')');
            } else {
                default_icon = icon;
            }
        } else {
            parseIcon(icon, size);
        }
    }

    // The source paths for icons and splashes are relative to
    // project's config.xml location, so we use it as base path.
    for (var density in android_icons) {
        var targetPath = getImageResourcePath(
            platformResourcesDir, 'mipmap', density, 'icon.png', path.basename(android_icons[density].src));
        resourceMap[targetPath] = android_icons[density].src;
    }

    // There's no "default" drawable, so assume default == mdpi.
    if (default_icon && !android_icons.mdpi) {
        var defaultTargetPath = getImageResourcePath(
            platformResourcesDir, 'mipmap', 'mdpi', 'icon.png', path.basename(default_icon.src));
        resourceMap[defaultTargetPath] = default_icon.src;
    }

    events.emit('verbose', 'Updating icons at ' + platformResourcesDir);
    FileUpdater.updatePaths(
        resourceMap, { rootDir: cordovaProject.root }, logFileOp);
}

function cleanIcons (projectRoot, projectConfig, platformResourcesDir) {
    var icons = projectConfig.getIcons('android');
    if (icons.length > 0) {
        var resourceMap = mapImageResources(projectRoot, platformResourcesDir, 'mipmap', 'icon.png');
        events.emit('verbose', 'Cleaning icons at ' + platformResourcesDir);

        // No source paths are specified in the map, so updatePaths() will delete the target files.
        FileUpdater.updatePaths(
            resourceMap, { rootDir: projectRoot, all: true }, logFileOp);
    }
}

/**
 * Gets a map containing resources of a specified name from all drawable folders in a directory.
 */
function mapImageResources (rootDir, subDir, type, resourceName) {
    var pathMap = {};
    shell.ls(path.join(rootDir, subDir, type + '-*')).forEach(function (drawableFolder) {
        var imagePath = path.join(subDir, path.basename(drawableFolder), resourceName);
        pathMap[imagePath] = null;
    });
    return pathMap;
}

function updateFileResources (cordovaProject, platformDir) {
    var files = cordovaProject.projectConfig.getFileResources('android');

    // if there are resource-file elements in config.xml
    if (files.length === 0) {
        events.emit('verbose', 'This app does not have additional resource files defined');
        return;
    }

    var resourceMap = {};
    files.forEach(function (res) {
        var targetPath = path.join(platformDir, res.target);
        resourceMap[targetPath] = res.src;
    });

    events.emit('verbose', 'Updating resource files at ' + platformDir);
    FileUpdater.updatePaths(
        resourceMap, { rootDir: cordovaProject.root }, logFileOp);
}

function cleanFileResources (projectRoot, projectConfig, platformDir) {
    var files = projectConfig.getFileResources('android', true);
    if (files.length > 0) {
        events.emit('verbose', 'Cleaning resource files at ' + platformDir);

        var resourceMap = {};
        files.forEach(function (res) {
            var filePath = path.join(platformDir, res.target);
            resourceMap[filePath] = null;
        });

        FileUpdater.updatePaths(
            resourceMap, {
                rootDir: projectRoot, all: true}, logFileOp);
    }
}

/**
 * Gets and validates 'AndroidLaunchMode' prepference from config.xml. Returns
 *   preference value and warns if it doesn't seems to be valid
 *
 * @param   {ConfigParser}  platformConfig  A configParser instance for
 *   platform.
 *
 * @return  {String}                  Preference's value from config.xml or
 *   default value, if there is no such preference. The default value is
 *   'singleTop'
 */
function findAndroidLaunchModePreference (platformConfig) {
    var launchMode = platformConfig.getPreference('AndroidLaunchMode');
    if (!launchMode) {
        // Return a default value
        return 'singleTop';
    }

    var expectedValues = ['standard', 'singleTop', 'singleTask', 'singleInstance'];
    var valid = expectedValues.indexOf(launchMode) >= 0;
    if (!valid) {
        // Note: warn, but leave the launch mode as developer wanted, in case the list of options changes in the future
        events.emit('warn', 'Unrecognized value for AndroidLaunchMode preference: ' +
            launchMode + '. Expected values are: ' + expectedValues.join(', '));
    }

    return launchMode;
}