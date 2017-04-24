// Copyright IBM Corp. 2013,2016. All Rights Reserved.
// Node module: loopback-datasource-juggler
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

// Turning on strict for this file breaks lots of test cases;
// disabling strict for this file
/* eslint-disable strict */

/*!
 * Module exports class Model
 */
module.exports = DataAccessObject;

/*!
 * Module dependencies
 */
const g = require('strong-globalize')();
const async = require('async');
const jutil = require('./jutil');
const ValidationError = require('./validations').ValidationError;
const Relation = require('./relations.js');
const Inclusion = require('./include.js');
const List = require('./list.js');
const geo = require('./geo');
const Memory = require('./connectors/memory').Memory;
const utils = require('./utils');
const fieldsToArray = utils.fieldsToArray;
const removeUndefined = utils.removeUndefined;
const setScopeValuesFromWhere = utils.setScopeValuesFromWhere;
const idEquals = utils.idEquals;
const mergeQuery = utils.mergeQuery;
const util = require('util');
const assert = require('assert');
const BaseModel = require('./model');
const debug = require('debug')('loopback:dao');

/**
 * Base class for all persistent objects.
 * Provides a common API to access any database connector.
 * This class describes only abstract behavior.  Refer to the specific connector for additional details.
 *
 * `DataAccessObject` mixes `Inclusion` classes methods.
 * @class DataAccessObject
 */
function DataAccessObject() {
  if (DataAccessObject._mixins) {
    const self = this;
    const args = arguments;
    DataAccessObject._mixins.forEach((m) => {
      m.call(self, args);
    });
  }
}

function idName(m) {
  return m.definition.idName() || 'id';
}

function getIdValue(m, data) {
  return data && data[idName(m)];
}

function copyData(from, to) {
  for (const key in from) {
    to[key] = from[key];
  }
}

function convertSubsetOfPropertiesByType(inst, data) {
  const typedData = {};
  for (const key in data) {
    // Convert the properties by type
    typedData[key] = inst[key];
    if (typeof typedData[key] === 'object' &&
            typedData[key] !== null &&
            typeof typedData[key].toObject === 'function') {
      typedData[key] = typedData[key].toObject();
    }
  }
  return typedData;
}

/**
 * Apply strict check for model's data.
 * Notice: Please note this method modifies `inst` when `strict` is `validate`.
 */
function applyStrictCheck(model, strict, data, inst, cb) {
  const props = model.definition.properties;
  const keys = Object.keys(data);
  let result = {},
    key;
  for (let i = 0; i < keys.length; i++) {
    key = keys[i];
    if (props[key]) {
      result[key] = data[key];
    } else if (strict) {
      inst.__unknownProperties.push(key);
    }
  }
  cb(null, result);
}

function setIdValue(m, data, value) {
  if (data) {
    data[idName(m)] = value;
  }
}

function byIdQuery(m, id) {
  const pk = idName(m);
  const query = {where: {}};
  query.where[pk] = id;
  return query;
}

function isWhereByGivenId(Model, where, idValue) {
  const keys = Object.keys(where);
  if (keys.length != 1) return false;

  const pk = idName(Model);
  if (keys[0] !== pk) return false;

  return where[pk] === idValue;
}

function errorModelNotFound(idValue) {
  const msg = g.f('Could not update attributes. {{Object}} with {{id}} %s does not exist!', idValue);
  const error = new Error(msg);
  error.statusCode = error.status = 404;
  return error;
}

DataAccessObject._forDB = function(data) {
  if (!(this.getDataSource().isRelational && this.getDataSource().isRelational())) {
    return data;
  }
  const res = {};
  for (const propName in data) {
    const type = this.getPropertyType(propName);
    if (type === 'JSON' || type === 'Any' || type === 'Object' || data[propName] instanceof Array) {
      res[propName] = JSON.stringify(data[propName]);
    } else {
      res[propName] = data[propName];
    }
  }
  return res;
};

DataAccessObject.defaultScope = function(target, inst) {
  let scope = this.definition.settings.scope;
  if (typeof scope === 'function') {
    scope = this.definition.settings.scope.call(this, target, inst);
  }
  return scope;
};

DataAccessObject.applyScope = function(query, inst) {
  const scope = this.defaultScope(query, inst) || {};
  if (typeof scope === 'object') {
    mergeQuery(query, scope || {}, this.definition.settings.scope);
  }
};

DataAccessObject.applyProperties = function(data, inst) {
  let properties = this.definition.settings.properties;
  properties = properties || this.definition.settings.attributes;
  if (typeof properties === 'object') {
    util._extend(data, properties);
  } else if (typeof properties === 'function') {
    util._extend(data, properties.call(this, data, inst) || {});
  } else if (properties !== false) {
    const scope = this.defaultScope(data, inst) || {};
    if (typeof scope.where === 'object') {
      setScopeValuesFromWhere(data, scope.where, this);
    }
  }
};

DataAccessObject.lookupModel = function(data) {
  return this;
};

/**
 * Get the connector instance for the given model class
 * @returns {Connector} The connector instance
 */
DataAccessObject.getConnector = function() {
  return this.getDataSource().connector;
};

/**
 * Verify if allowExtendedOperators is enabled
 * @options {Object} [options] Optional options to use.
 * @property {Boolean} allowExtendedOperators.
 * @returns {Boolean} Returns `true` if allowExtendedOperators is enabled, else `false`.
 */
DataAccessObject._allowExtendedOperators = function(options) {
  options = options || {};

  const Model = this;
  const dsSettings = this.getDataSource().settings;
  let allowExtendedOperators = dsSettings.allowExtendedOperators;
  // options settings enable allowExtendedOperators per request (for example if
  // enable allowExtendedOperators only server side);
  // model settings enable allowExtendedOperators only for specific model.
  // dataSource settings enable allowExtendedOperators globally (all models);
  // options -> model -> dataSource (connector)
  if (options.hasOwnProperty('allowExtendedOperators')) {
    allowExtendedOperators = options.allowExtendedOperators === true;
  } else if (Model.settings && Model.settings.hasOwnProperty('allowExtendedOperators')) {
    allowExtendedOperators = Model.settings.allowExtendedOperators === true;
  }
  return allowExtendedOperators;
};

// Empty callback function
function noCallback(err, result) {
  // NOOP
  debug('callback is ignored: err=%j, result=%j', err, result);
}

/**
 * Create an instance of Model with given data and save to the attached data source. Callback is optional.
 * Example:
 *```js
 * User.create({first: 'Joe', last: 'Bob'}, function(err, user) {
 *  console.log(user instanceof User); // true
 * });
 * ```
 * Note: You must include a callback and use the created model provided in the callback if your code depends on your model being
 * saved or having an ID.
 *
 * @param {Object} [data] Optional data object
 * @param {Object} [options] Options for create
 * @param {Function} [cb]  Callback function called with these arguments:
 *   - err (null or Error)
 *   - instance (null or Model)
 */
DataAccessObject.create = function(data, options, cb) {
  const connectionPromise = stillConnecting(this.getDataSource(), this, arguments);
  if (connectionPromise) {
    return connectionPromise;
  }

  let Model = this;
  const connector = Model.getConnector();
  assert(typeof connector.create === 'function',
    'create() must be implemented by the connector');

  const self = this;

  if (options === undefined && cb === undefined) {
    if (typeof data === 'function') {
      // create(cb)
      cb = data;
      data = {};
    }
  } else if (cb === undefined) {
    if (typeof options === 'function') {
      // create(data, cb);
      cb = options;
      options = {};
    }
  }

  data = data || {};
  options = options || {};
  cb = cb || (Array.isArray(data) ? noCallback : utils.createPromiseCallback());

  assert(typeof data === 'object', 'The data argument must be an object or array');
  assert(typeof options === 'object', 'The options argument must be an object');
  assert(typeof cb === 'function', 'The cb argument must be a function');

  const hookState = {};

  if (Array.isArray(data)) {
    // Undefined item will be skipped by async.map() which internally uses
    // Array.prototype.map(). The following loop makes sure all items are
    // iterated
    for (let i = 0, n = data.length; i < n; i++) {
      if (data[i] === undefined) {
        data[i] = {};
      }
    }
    async.map(data, (item, done) => {
      self.create(item, options, (err, result) => {
        // Collect all errors and results
        done(null, {err, result: result || item});
      });
    }, (err, results) => {
      if (err) {
        return cb(err, results);
      }
      // Convert the results into two arrays
      let errors = null;
      const data = [];
      for (let i = 0, n = results.length; i < n; i++) {
        if (results[i].err) {
          if (!errors) {
            errors = [];
          }
          errors[i] = results[i].err;
        }
        data[i] = results[i].result;
      }
      cb(errors, data);
    });
    return;
  }

  const enforced = {};
  let obj;
  const idValue = getIdValue(this, data);

  // if we come from save
  if (data instanceof Model && !idValue) {
    obj = data;
  } else {
    obj = new Model(data);
  }

  this.applyProperties(enforced, obj);
  obj.setAttributes(enforced);

  Model = this.lookupModel(data); // data-specific
  if (Model !== obj.constructor) obj = new Model(data);

  let context = {
    Model,
    instance: obj,
    isNewInstance: true,
    hookState,
    options,
  };
  Model.notifyObserversOf('before save', context, (err) => {
    if (err) return cb(err);

    data = obj.toObject(true);

    // options has precedence on model-setting
    if (options.validate === false) {
      return create();
    }

    // only when options.validate is not set, take model-setting into consideration
    if (options.validate === undefined && Model.settings.automaticValidation === false) {
      return create();
    }

    // validation required
    obj.isValid((valid) => {
      if (valid) {
        create();
      } else {
        cb(new ValidationError(obj), obj);
      }
    }, data, options);
  });

  function create() {
    obj.trigger('create', (createDone) => {
      obj.trigger('save', (saveDone) => {
        const _idName = idName(Model);
        const modelName = Model.modelName;
        const val = removeUndefined(obj.toObject(true));
        function createCallback(err, id, rev) {
          if (id) {
            obj.__data[_idName] = id;
            defineReadonlyProp(obj, _idName, id);
          }
          if (rev) {
            obj._rev = rev;
          }
          if (err) {
            return cb(err, obj);
          }
          obj.__persisted = true;

          const context = {
            Model,
            data: val,
            isNewInstance: true,
            hookState,
            options,
          };
          Model.notifyObserversOf('loaded', context, (err) => {
            if (err) return cb(err);

            // By default, the instance passed to create callback is NOT updated
            // with the changes made through persist/loaded hooks. To preserve
            // backwards compatibility, we introduced a new setting updateOnLoad,
            // which if set, will apply these changes to the model instance too.
            if (Model.settings.updateOnLoad) {
              obj.setAttributes(context.data);
            }
            saveDone.call(obj, () => {
              createDone.call(obj, () => {
                if (err) {
                  return cb(err, obj);
                }
                const context = {
                  Model,
                  instance: obj,
                  isNewInstance: true,
                  hookState,
                  options,
                };
                if (options.notify !== false) {
                  Model.notifyObserversOf('after save', context, (err) => {
                    cb(err, obj);
                  });
                } else {
                  cb(null, obj);
                }
              });
            });
          });
        }

        context = {
          Model,
          data: val,
          isNewInstance: true,
          currentInstance: obj,
          hookState,
          options,
        };
        Model.notifyObserversOf('persist', context, (err) => {
          if (err) return cb(err);

          if (connector.create.length === 4) {
            connector.create(modelName, obj.constructor._forDB(context.data), options, createCallback);
          } else {
            connector.create(modelName, obj.constructor._forDB(context.data), createCallback);
          }
        });
      }, obj, cb);
    }, obj, cb);
  }

  return cb.promise;
};

function stillConnecting(dataSource, obj, args) {
  if (typeof args[args.length - 1] === 'function') {
    return dataSource.ready(obj, args);
  }

  // promise variant
  const promiseArgs = Array.prototype.slice.call(args);
  promiseArgs.callee = args.callee;
  const cb = utils.createPromiseCallback();
  promiseArgs.push(cb);
  if (dataSource.ready(obj, promiseArgs)) {
    return cb.promise;
  }
  return false;
}

/**
 * Update or insert a model instance: update exiting record if one is found, such that parameter `data.id` matches `id` of model instance;
 * otherwise, insert a new record.
 *
 * NOTE: No setters, validations, or hooks are applied when using upsert.
 * `updateOrCreate` and `patchOrCreate` are aliases
 * @param {Object} data The model instance data
 * @param {Object} [options] Options for upsert
 * @param {Function} cb The callback function (optional).
 */
// [FIXME] rfeng: This is a hack to set up 'upsert' first so that
// 'upsert' will be used as the name for strong-remoting to keep it backward
// compatible for angular SDK
DataAccessObject.updateOrCreate =
DataAccessObject.patchOrCreate =
DataAccessObject.upsert = function(data, options, cb) {
  const connectionPromise = stillConnecting(this.getDataSource(), this, arguments);
  if (connectionPromise) {
    return connectionPromise;
  }

  if (options === undefined && cb === undefined) {
    if (typeof data === 'function') {
      // upsert(cb)
      cb = data;
      data = {};
    }
  } else if (cb === undefined) {
    if (typeof options === 'function') {
      // upsert(data, cb)
      cb = options;
      options = {};
    }
  }

  cb = cb || utils.createPromiseCallback();
  data = data || {};
  options = options || {};

  assert(typeof data === 'object', 'The data argument must be an object');
  assert(typeof options === 'object', 'The options argument must be an object');
  assert(typeof cb === 'function', 'The cb argument must be a function');

  if (Array.isArray(data)) {
    cb(new Error('updateOrCreate does not support bulk mode or any array input'));
    return cb.promise;
  }

  const hookState = {};

  const self = this;
  let Model = this;
  const connector = Model.getConnector();

  const id = getIdValue(this, data);
  if (id === undefined || id === null) {
    return this.create(data, options, cb);
  }
  let doValidate;
  if (options.validate === undefined) {
    if (Model.settings.validateUpsert === undefined) {
      if (Model.settings.automaticValidation !== undefined) {
        doValidate = Model.settings.automaticValidation;
      }
    } else {
      doValidate = Model.settings.validateUpsert;
    }
  } else {
    doValidate = options.validate;
  }

  const forceId = this.settings.forceId;
  if (forceId) {
    options = Object.create(options);
    options.validate = !!doValidate;
    if (doValidate) {
      Model.findById(id, options, (err, model) => {
        if (err) return cb(err);
        if (!model) return cb(errorModelNotFound(id));
        model.updateAttributes(data, options, cb);
      });
    } else {
      const model = new Model({id}, {persisted: true});
      model.updateAttributes(data, options, cb);
    }
    return;
  }

  const context = {
    Model,
    query: byIdQuery(Model, id),
    hookState,
    options,
  };
  Model.notifyObserversOf('access', context, doUpdateOrCreate);

  function doUpdateOrCreate(err, ctx) {
    if (err) return cb(err);

    const isOriginalQuery = isWhereByGivenId(Model, ctx.query.where, id);
    if (connector.updateOrCreate && isOriginalQuery) {
      let context = {
        Model,
        where: ctx.query.where,
        data,
        hookState,
        options,
      };
      Model.notifyObserversOf('before save', context, (err, ctx) => {
        if (err) return cb(err);

        data = ctx.data;
        let update = data;
        let inst = data;
        if (!(data instanceof Model)) {
          inst = new Model(data, {applyDefaultValues: false});
        }
        update = inst.toObject(false);

        Model.applyProperties(update, inst);
        Model = Model.lookupModel(update);

        const connector = self.getConnector();

        if (doValidate === false) {
          callConnector();
        } else {
          inst.isValid((valid) => {
            if (!valid) {
              if (doValidate) { // backwards compatibility with validateUpsert:undefined
                return cb(new ValidationError(inst), inst);
              }
                // TODO(bajtos) Remove validateUpsert:undefined in v3.0
              g.warn('Ignoring validation errors in {{updateOrCreate()}}:');
              g.warn('  %s', new ValidationError(inst).message);
                // continue with updateOrCreate
            }
            callConnector();
          }, update, options);
        }

        function callConnector() {
          update = removeUndefined(update);
          context = {
            Model,
            where: ctx.where,
            data: update,
            currentInstance: inst,
            hookState: ctx.hookState,
            options,
          };
          Model.notifyObserversOf('persist', context, (err) => {
            if (err) return done(err);
            if (connector.updateOrCreate.length === 4) {
              connector.updateOrCreate(Model.modelName, update, options, done);
            } else {
              connector.updateOrCreate(Model.modelName, update, done);
            }
          });
        }
        function done(err, data, info) {
          if (err) return cb(err);
          const context = {
            Model,
            data,
            isNewInstance: info && info.isNewInstance,
            hookState: ctx.hookState,
            options,
          };
          Model.notifyObserversOf('loaded', context, (err) => {
            if (err) return cb(err);

            let obj;
            if (data && !(data instanceof Model)) {
              inst._initProperties(data, {persisted: true});
              obj = inst;
            } else {
              obj = data;
            }
            if (err) {
              cb(err, obj);
            } else {
              const context = {
                Model,
                instance: obj,
                isNewInstance: info ? info.isNewInstance : undefined,
                hookState,
                options,
              };

              if (options.notify !== false) {
                Model.notifyObserversOf('after save', context, (err) => {
                  cb(err, obj);
                });
              } else {
                cb(null, obj);
              }
            }
          });
        }
      });
    } else {
      const opts = {notify: false};
      if (ctx.options && ctx.options.transaction) {
        opts.transaction = ctx.options.transaction;
      }
      Model.findOne({where: ctx.query.where}, opts, (err, inst) => {
        if (err) {
          return cb(err);
        }
        if (!isOriginalQuery) {
          // The custom query returned from a hook may hide the fact that
          // there is already a model with `id` value `data[idName(Model)]`
          delete data[idName(Model)];
        }
        if (inst) {
          inst.updateAttributes(data, options, cb);
        } else {
          Model = self.lookupModel(data);
          const obj = new Model(data);
          obj.save(options, cb);
        }
      });
    }
  }
  return cb.promise;
};
/**
 * Update or insert a model instance based on the search criteria.
 * If there is a single instance retrieved, update the retrieved model.
 * Creates a new model if no model instances were found.
 * Returns an error if multiple instances are found.
 * @param {Object} [where]  `where` filter, like
 * ```
 * { key: val, key2: {gt: 'val2'}, ...}
 * ```
 * <br/>see
 * [Where filter](https://docs.strongloop.com/display/LB/Where+filter#Wherefilter-Whereclauseforothermethods).
 * @param {Object} data The model instance data to insert.
 * @callback {Function} callback Callback function called with `cb(err, obj)` signature.
 * @param {Error} err Error object; see [Error object](http://docs.strongloop.com/display/LB/Error+object).
 * @param {Object} model Updated model instance.
 */
DataAccessObject.patchOrCreateWithWhere =
DataAccessObject.upsertWithWhere = function(where, data, options, cb) {
  const connectionPromise = stillConnecting(this.getDataSource(), this, arguments);
  if (connectionPromise) { return connectionPromise; }
  if (cb === undefined) {
    if (typeof options === 'function') {
      // upsertWithWhere(where, data, cb)
      cb = options;
      options = {};
    }
  }
  cb = cb || utils.createPromiseCallback();
  options = options || {};
  assert(typeof where === 'object', 'The where argument must be an object');
  assert(typeof data === 'object', 'The data argument must be an object');
  assert(typeof options === 'object', 'The options argument must be an object');
  assert(typeof cb === 'function', 'The cb argument must be a function');
  if (Object.keys(data).length === 0) {
    const err = new Error('data object cannot be empty!');
    err.statusCode = 400;
    process.nextTick(() => { cb(err); });
    return cb.promise;
  }
  const hookState = {};
  const self = this;
  let Model = this;
  const connector = Model.getConnector();
  const modelName = Model.modelName;
  const query = {where};
  const context = {
    Model,
    query,
    hookState,
    options,
  };
  Model.notifyObserversOf('access', context, doUpsertWithWhere);
  function doUpsertWithWhere(err, ctx) {
    if (err) return cb(err);
    ctx.data = data;
    if (connector.upsertWithWhere) {
      let context = {
        Model,
        where: ctx.query.where,
        data: ctx.data,
        hookState,
        options,
      };
      Model.notifyObserversOf('before save', context, (err, ctx) => {
        if (err) return cb(err);
        data = ctx.data;
        let update = data;
        let inst = data;
        if (!(data instanceof Model)) {
          inst = new Model(data, {applyDefaultValues: false});
        }
        update = inst.toObject(false);
        Model.applyScope(query);
        Model.applyProperties(update, inst);
        Model = Model.lookupModel(update);
        if (options.validate === false) {
          return callConnector();
        }
        if (options.validate === undefined && Model.settings.automaticValidation === false) {
          return callConnector();
        }
        inst.isValid((valid) => {
          if (!valid) return cb(new ValidationError(inst), inst);
          callConnector();
        }, update, options);

        function callConnector() {
          try {
            ctx.where = removeUndefined(ctx.where);
            ctx.where = Model._coerce(ctx.where, options);
            update = removeUndefined(update);
            update = Model._coerce(update, options);
          } catch (err) {
            return process.nextTick(() => {
              cb(err);
            });
          }
          context = {
            Model,
            where: ctx.where,
            data: update,
            currentInstance: inst,
            hookState: ctx.hookState,
            options,
          };
          Model.notifyObserversOf('persist', context, (err) => {
            if (err) return done(err);
            connector.upsertWithWhere(modelName, ctx.where, update, options, done);
          });
        }
        function done(err, data, info) {
          if (err) return cb(err);
          const contxt = {
            Model,
            data,
            isNewInstance: info && info.isNewInstance,
            hookState: ctx.hookState,
            options,
          };
          Model.notifyObserversOf('loaded', contxt, (err) => {
            if (err) return cb(err);
            let obj;
            if (contxt.data && !(contxt.data instanceof Model)) {
              inst._initProperties(contxt.data, {persisted: true});
              obj = inst;
            } else {
              obj = contxt.data;
            }
            const context = {
              Model,
              instance: obj,
              isNewInstance: info ? info.isNewInstance : undefined,
              hookState,
              options,
            };
            Model.notifyObserversOf('after save', context, (err) => {
              cb(err, obj);
            });
          });
        }
      });
    } else {
      const opts = {notify: false};
      if (ctx.options && ctx.options.transaction) {
        opts.transaction = ctx.options.transaction;
      }
      self.find({where: ctx.query.where}, opts, (err, instances) => {
        if (err) return cb(err);
        const modelsLength = instances.length;
        if (modelsLength === 0) {
          self.create(data, options, cb);
        } else if (modelsLength === 1) {
          const modelInst = instances[0];
          modelInst.updateAttributes(data, options, cb);
        } else {
          process.nextTick(() => {
            const error = new Error('There are multiple instances found.' +
                'Upsert Operation will not be performed!');
            error.statusCode = 400;
            cb(error);
          });
        }
      });
    }
  }
  return cb.promise;
};
/**
 * Replace or insert a model instance: replace exiting record if one is found, such that parameter `data.id` matches `id` of model instance;
 * otherwise, insert a new record.
 *
 * @param {Object} data The model instance data
 * @param {Object} [options] Options for replaceOrCreate
 * @param {Function} cb The callback function (optional).
 */

DataAccessObject.replaceOrCreate = function replaceOrCreate(data, options, cb) {
  const connectionPromise = stillConnecting(this.getDataSource(), this, arguments);
  if (connectionPromise) {
    return connectionPromise;
  }

  if (cb === undefined) {
    if (typeof options === 'function') {
      // replaceOrCreta(data,cb)
      cb = options;
      options = {};
    }
  }

  cb = cb || utils.createPromiseCallback();
  data = data || {};
  options = options || {};

  assert(typeof data === 'object', 'The data argument must be an object');
  assert(typeof options === 'object', 'The options argument must be an object');
  assert(typeof cb === 'function', 'The cb argument must be a function');

  const hookState = {};

  const self = this;
  let Model = this;
  const connector = Model.getConnector();

  let id = getIdValue(this, data);
  if (id === undefined || id === null) {
    return this.create(data, options, cb);
  }

  const forceId = this.settings.forceId;
  if (forceId) {
    return Model.replaceById(id, data, options, cb);
  }

  let inst;
  if (data instanceof Model) {
    inst = data;
  } else {
    inst = new Model(data);
  }

  const strict = inst.__strict;
  const context = {
    Model,
    query: byIdQuery(Model, id),
    hookState,
    options,
  };
  Model.notifyObserversOf('access', context, doReplaceOrCreate);

  function doReplaceOrCreate(err, ctx) {
    if (err) return cb(err);

    const isOriginalQuery = isWhereByGivenId(Model, ctx.query.where, id);
    const where = ctx.query.where;
    if (connector.replaceOrCreate && isOriginalQuery) {
      let context = {
        Model,
        instance: inst,
        hookState,
        options,
      };
      Model.notifyObserversOf('before save', context, (err, ctx) => {
        if (err) return cb(err);
        let update = inst.toObject(false);
        if (strict) {
          applyStrictCheck(Model, strict, update, inst, validateAndCallConnector);
        } else {
          validateAndCallConnector();
        }

        function validateAndCallConnector(err) {
          if (err) return cb(err);
          Model.applyProperties(update, inst);
          Model = Model.lookupModel(update);

          const connector = self.getConnector();

          if (options.validate === false) {
            return callConnector();
          }

          // only when options.validate is not set, take model-setting into consideration
          if (options.validate === undefined && Model.settings.automaticValidation === false) {
            return callConnector();
          }

          inst.isValid((valid) => {
            if (!valid) return cb(new ValidationError(inst), inst);
            callConnector();
          }, update, options);

          function callConnector() {
            update = removeUndefined(update);
            context = {
              Model,
              where,
              data: update,
              currentInstance: inst,
              hookState: ctx.hookState,
              options,
            };
            Model.notifyObserversOf('persist', context, (err) => {
              if (err) return done(err);
              connector.replaceOrCreate(Model.modelName, context.data, options, done);
            });
          }
          function done(err, data, info) {
            if (err) return cb(err);
            const context = {
              Model,
              data,
              isNewInstance: info ? info.isNewInstance : undefined,
              hookState: ctx.hookState,
              options,
            };
            Model.notifyObserversOf('loaded', context, (err) => {
              if (err) return cb(err);

              let obj;
              if (data && !(data instanceof Model)) {
                inst._initProperties(data, {persisted: true});
                obj = inst;
              } else {
                obj = data;
              }
              if (err) {
                cb(err, obj);
              } else {
                const context = {
                  Model,
                  instance: obj,
                  isNewInstance: info ? info.isNewInstance : undefined,
                  hookState,
                  options,
                };

                Model.notifyObserversOf('after save', context, (err) => {
                  cb(err, obj, info);
                });
              }
            });
          }
        }
      });
    } else {
      const opts = {notify: false};
      if (ctx.options && ctx.options.transaction) {
        opts.transaction = ctx.options.transaction;
      }
      Model.findOne({where: ctx.query.where}, opts, (err, found) => {
        if (err) return cb(err);
        if (!isOriginalQuery) {
          // The custom query returned from a hook may hide the fact that
          // there is already a model with `id` value `data[idName(Model)]`
          const pkName = idName(Model);
          delete data[pkName];
          if (found) id = found[pkName];
        }
        if (found) {
          self.replaceById(id, data, options, cb);
        } else {
          Model = self.lookupModel(data);
          const obj = new Model(data);
          obj.save(options, cb);
        }
      });
    }
  }
  return cb.promise;
};

/**
 * Find one record that matches specified query criteria.  Same as `find`, but limited to one record, and this function returns an
 * object, not a collection.
 * If the specified instance is not found, then create it using data provided as second argument.
 *
 * @param {Object} query Search conditions. See [find](#dataaccessobjectfindquery-callback) for query format.
 * For example: `{where: {test: 'me'}}`.
 * @param {Object} data Object to create.
 * @param {Object} [options] Option for findOrCreate
 * @param {Function} cb Callback called with (err, instance, created)
 */
DataAccessObject.findOrCreate = function findOrCreate(query, data, options, cb) {
  const connectionPromise = stillConnecting(this.getDataSource(), this, arguments);
  if (connectionPromise) {
    return connectionPromise;
  }

  assert(arguments.length >= 1, 'At least one argument is required');
  if (data === undefined && options === undefined && cb === undefined) {
    assert(typeof query === 'object', 'Single argument must be data object');
    // findOrCreate(data);
    // query will be built from data, and method will return Promise
    data = query;
    query = {where: data};
  } else if (options === undefined && cb === undefined) {
    if (typeof data === 'function') {
      // findOrCreate(data, cb);
      // query will be built from data
      cb = data;
      data = query;
      query = {where: data};
    }
  } else if (cb === undefined) {
    if (typeof options === 'function') {
      // findOrCreate(query, data, cb)
      cb = options;
      options = {};
    }
  }

  cb = cb || utils.createPromiseCallback();
  query = query || {where: {}};
  data = data || {};
  options = options || {};

  assert(typeof query === 'object', 'The query argument must be an object');
  assert(typeof data === 'object', 'The data argument must be an object');
  assert(typeof options === 'object', 'The options argument must be an object');
  assert(typeof cb === 'function', 'The cb argument must be a function');

  const hookState = {};

  const Model = this;
  const self = this;
  const connector = Model.getConnector();

  function _findOrCreate(query, data, currentInstance) {
    const modelName = self.modelName;
    function findOrCreateCallback(err, data, created) {
      if (err) return cb(err);
      const context = {
        Model,
        data,
        isNewInstance: created,
        hookState,
        options,
      };
      Model.notifyObserversOf('loaded', context, (err) => {
        if (err) return cb(err);

        let obj,
          Model = self.lookupModel(data);

        if (data) {
          obj = new Model(data, {fields: query.fields,
            applySetters: false,
            persisted: true});
        }

        if (created) {
          const context = {
            Model,
            instance: obj,
            isNewInstance: true,
            hookState,
            options,
          };
          Model.notifyObserversOf('after save', context, (err) => {
            if (cb.promise) {
              cb(err, [obj, created]);
            } else {
              cb(err, obj, created);
            }
          });
        } else if (cb.promise) {
          cb(err, [obj, created]);
        } else {
          cb(err, obj, created);
        }
      });
    }

    data = removeUndefined(data);
    const context = {
      Model,
      where: query.where,
      data,
      isNewInstance: true,
      currentInstance,
      hookState,
      options,
    };

    Model.notifyObserversOf('persist', context, (err) => {
      if (err) return cb(err);

      if (connector.findOrCreate.length === 5) {
        connector.findOrCreate(modelName, query, self._forDB(context.data), options, findOrCreateCallback);
      } else {
        connector.findOrCreate(modelName, query, self._forDB(context.data), findOrCreateCallback);
      }
    });
  }

  if (connector.findOrCreate) {
    query.limit = 1;

    try {
      this._normalize(query, options);
    } catch (err) {
      process.nextTick(() => {
        cb(err);
      });
      return cb.promise;
    }

    this.applyScope(query);

    const context = {
      Model,
      query,
      hookState,
      options,
    };
    Model.notifyObserversOf('access', context, (err, ctx) => {
      if (err) return cb(err);

      const query = ctx.query;

      const enforced = {};
      const Model = self.lookupModel(data);
      const obj = data instanceof Model ? data : new Model(data);

      Model.applyProperties(enforced, obj);
      obj.setAttributes(enforced);

      const context = {
        Model,
        instance: obj,
        isNewInstance: true,
        hookState,
        options,
      };
      Model.notifyObserversOf('before save', context, (err, ctx) => {
        if (err) return cb(err);

        const obj = ctx.instance;
        const data = obj.toObject(true);

        // options has precedence on model-setting
        if (options.validate === false) {
          return _findOrCreate(query, data, obj);
        }

        // only when options.validate is not set, take model-setting into consideration
        if (options.validate === undefined && Model.settings.automaticValidation === false) {
          return _findOrCreate(query, data, obj);
        }

        // validation required
        obj.isValid((valid) => {
          if (valid) {
            _findOrCreate(query, data, obj);
          } else {
            cb(new ValidationError(obj), obj);
          }
        }, data, options);
      });
    });
  } else {
    Model.findOne(query, options, (err, record) => {
      if (err) return cb(err);
      if (record) {
        if (cb.promise) {
          return cb(null, [record, false]);
        }
        return cb(null, record, false);
      }
      Model.create(data, options, (err, record) => {
        if (cb.promise) {
          cb(err, [record, record != null]);
        } else {
          cb(err, record, record != null);
        }
      });
    });
  }
  return cb.promise;
};

/**
 * Check whether a model instance exists in database
 *
 * @param {id} id Identifier of object (primary key value)
 * @param {Object} [options] Options
 * @param {Function} cb Callback function called with (err, exists: Bool)
 */
DataAccessObject.exists = function exists(id, options, cb) {
  const connectionPromise = stillConnecting(this.getDataSource(), this, arguments);
  if (connectionPromise) {
    return connectionPromise;
  }

  assert(arguments.length >= 1, 'The id argument is required');
  if (cb === undefined) {
    if (typeof options === 'function') {
      // exists(id, cb)
      cb = options;
      options = {};
    }
  }

  cb = cb || utils.createPromiseCallback();
  options = options || {};

  assert(typeof options === 'object', 'The options argument must be an object');
  assert(typeof cb === 'function', 'The cb argument must be a function');

  if (id !== undefined && id !== null && id !== '') {
    this.count(byIdQuery(this, id).where, options, (err, count) => {
      cb(err, err ? false : count === 1);
    });
  } else {
    process.nextTick(() => {
      cb(new Error(g.f('{{Model::exists}} requires the {{id}} argument')));
    });
  }
  return cb.promise;
};

/**
 * Find model instance by ID.
 *
 * Example:
 * ```js
 * User.findById(23, function(err, user) {
 *   console.info(user.id); // 23
 * });
 * ```
 *
 * @param {*} id Primary key value
 * @param {Object} [filter] The filter that contains `include` or `fields`.
 * Other settings such as `where`, `order`, `limit`, or `offset` will be
 * ignored.
 * @param {Object} [options] Options
 * @param {Function} cb Callback called with (err, instance)
 */
DataAccessObject.findById = function findById(id, filter, options, cb) {
  const connectionPromise = stillConnecting(this.getDataSource(), this, arguments);
  if (connectionPromise) {
    return connectionPromise;
  }

  assert(arguments.length >= 1, 'The id argument is required');

  if (options === undefined && cb === undefined) {
    if (typeof filter === 'function') {
      // findById(id, cb)
      cb = filter;
      filter = {};
    }
  } else if (cb === undefined) {
    if (typeof options === 'function') {
      // findById(id, query, cb)
      cb = options;
      options = {};
      if (typeof filter === 'object' && !(filter.include || filter.fields)) {
        // If filter doesn't have include or fields, assuming it's options
        options = filter;
        filter = {};
      }
    }
  }

  cb = cb || utils.createPromiseCallback();
  options = options || {};
  filter = filter || {};

  assert(typeof filter === 'object', 'The filter argument must be an object');
  assert(typeof options === 'object', 'The options argument must be an object');
  assert(typeof cb === 'function', 'The cb argument must be a function');

  if (isPKMissing(this, cb)) {
    return cb.promise;
  } else if (id == null || id === '') {
    process.nextTick(() => {
      cb(new Error(g.f('{{Model::findById}} requires the {{id}} argument')));
    });
  } else {
    const query = byIdQuery(this, id);
    if (filter.include) {
      query.include = filter.include;
    }
    if (filter.fields) {
      query.fields = filter.fields;
    }
    this.findOne(query, options, cb);
  }
  return cb.promise;
};

/**
 * Find model instances by ids
 * @param {Array} ids An array of ids
 * @param {Object} query Query filter
 * @param {Object} [options] Options
 * @param {Function} cb Callback called with (err, instance)
 */
DataAccessObject.findByIds = function(ids, query, options, cb) {
  if (options === undefined && cb === undefined) {
    if (typeof query === 'function') {
      // findByIds(ids, cb)
      cb = query;
      query = {};
    }
  } else if (cb === undefined) {
    if (typeof options === 'function') {
      // findByIds(ids, query, cb)
      cb = options;
      options = {};
    }
  }

  cb = cb || utils.createPromiseCallback();
  options = options || {};
  query = query || {};

  assert(Array.isArray(ids), 'The ids argument must be an array');
  assert(typeof query === 'object', 'The query argument must be an object');
  assert(typeof options === 'object', 'The options argument must be an object');
  assert(typeof cb === 'function', 'The cb argument must be a function');

  if (isPKMissing(this, cb)) {
    return cb.promise;
  } else if (ids.length === 0) {
    process.nextTick(() => { cb(null, []); });
    return cb.promise;
  }

  const filter = {where: {}};
  const pk = idName(this);
  filter.where[pk] = {inq: [].concat(ids)};
  mergeQuery(filter, query || {});

  // to know if the result need to be sorted by ids or not
  // this variable need to be initialized before the call to find, because filter is updated during the call with an order
  const toSortObjectsByIds = !filter.order;

  this.find(filter, options, (err, results) => {
    cb(err, toSortObjectsByIds ? utils.sortObjectsByIds(pk, ids, results) : results);
  });
  return cb.promise;
};

function convertNullToNotFoundError(ctx, cb) {
  if (ctx.result !== null) return cb();

  const modelName = ctx.method.sharedClass.name;
  const id = ctx.getArgByName('id');
  const msg = g.f('Unknown "%s" {{id}} "%s".', modelName, id);
  const error = new Error(msg);
  error.statusCode = error.status = 404;
  cb(error);
}

// alias function for backwards compat.
DataAccessObject.all = function() {
  return DataAccessObject.find.apply(this, arguments);
};

/**
 * Get settings via hiarchical determiniation
 *
 * @param {String} key The setting key
 */
DataAccessObject._getSetting = function(key) {
  // Check for settings in model
  const m = this.definition;
  if (m && m.settings && m.settings[key]) {
    return m.settings[key];
  }

  // Check for settings in connector
  const ds = this.getDataSource();
  if (ds && ds.settings && ds.settings[key]) {
    return ds.settings[key];
  }

  return;
};

const operators = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  between: 'BETWEEN',
  inq: 'IN',
  nin: 'NOT IN',
  neq: '!=',
  like: 'LIKE',
  nlike: 'NOT LIKE',
  ilike: 'ILIKE',
  nilike: 'NOT ILIKE',
  regexp: 'REGEXP',
};

/*
 * Normalize the filter object and throw errors if invalid values are detected
 * @param {Object} filter The query filter object
 * @options {Object} [options] Optional options to use.
 * @property {Boolean} allowExtendedOperators.
 * @returns {Object} The normalized filter object
 * @private
 */
DataAccessObject._normalize = function(filter, options) {
  if (!filter) {
    return undefined;
  }
  let err = null;
  if ((typeof filter !== 'object') || Array.isArray(filter)) {
    err = new Error(g.f('The query filter %j is not an {{object}}', filter));
    err.statusCode = 400;
    throw err;
  }
  if (filter.limit || filter.skip || filter.offset) {
    const limit = Number(filter.limit || 100);
    const offset = Number(filter.skip || filter.offset || 0);
    if (isNaN(limit) || limit <= 0 || Math.ceil(limit) !== limit) {
      err = new Error(g.f('The {{limit}} parameter %j is not valid',
        filter.limit));
      err.statusCode = 400;
      throw err;
    }
    if (isNaN(offset) || offset < 0 || Math.ceil(offset) !== offset) {
      err = new Error(g.f('The {{offset/skip}} parameter %j is not valid',
          filter.skip || filter.offset));
      err.statusCode = 400;
      throw err;
    }
    filter.limit = limit;
    filter.offset = offset;
    filter.skip = offset;
  }

  if (filter.order) {
    let order = filter.order;
    if (!Array.isArray(order)) {
      order = [order];
    }
    const fields = [];
    for (let i = 0, m = order.length; i < m; i++) {
      if (typeof order[i] === 'string') {
        // Normalize 'f1 ASC, f2 DESC, f3' to ['f1 ASC', 'f2 DESC', 'f3']
        const tokens = order[i].split(/(?:\s*,\s*)+/);
        for (let t = 0, n = tokens.length; t < n; t++) {
          let token = tokens[t];
          if (token.length === 0) {
            // Skip empty token
            continue;
          }
          const parts = token.split(/\s+/);
          if (parts.length >= 2) {
            const dir = parts[1].toUpperCase();
            if (dir === 'ASC' || dir === 'DESC') {
              token = `${parts[0]} ${dir}`;
            } else {
              err = new Error(g.f('The {{order}} %j has invalid direction', token));
              err.statusCode = 400;
              throw err;
            }
          }
          fields.push(token);
        }
      } else {
        err = new Error(g.f('The order %j is not valid', order[i]));
        err.statusCode = 400;
        throw err;
      }
    }
    if (fields.length === 1 && typeof filter.order === 'string') {
      filter.order = fields[0];
    } else {
      filter.order = fields;
    }
  }

  // normalize fields as array of included property names
  if (filter.fields) {
    filter.fields = fieldsToArray(filter.fields,
      Object.keys(this.definition.properties), this.settings.strict);
  }

  const handleUndefined = this._getSetting('normalizeUndefinedInQuery');
  // alter configuration of how removeUndefined handles undefined values
  filter = removeUndefined(filter, handleUndefined);
  this._coerce(filter.where, options);
  return filter;
};

function DateType(arg) {
  const d = new Date(arg);
  if (isNaN(d.getTime())) {
    throw new Error(g.f('Invalid date: %s', arg));
  }
  return d;
}

function BooleanType(arg) {
  if (typeof arg === 'string') {
    switch (arg) {
      case 'true':
      case '1':
        return true;
      case 'false':
      case '0':
        return false;
    }
  }
  if (arg == null) {
    return null;
  }
  return Boolean(arg);
}

function NumberType(val) {
  const num = Number(val);
  return !isNaN(num) ? num : val;
}

function coerceArray(val) {
  if (Array.isArray(val)) {
    return val;
  }

  if (!utils.isPlainObject(val)) {
    throw new Error(g.f('Value is not an {{array}} or {{object}} with sequential numeric indices'));
  }

  // It is an object, check if empty
  const props = Object.keys(val);

  if (props.length === 0) {
    throw new Error(g.f('Value is an empty {{object}}'));
  }

  const arrayVal = new Array(props.length);
  for (let i = 0; i < arrayVal.length; ++i) {
    if (!val.hasOwnProperty(i)) {
      throw new Error(g.f('Value is not an {{array}} or {{object}} with sequential numeric indices'));
    }

    arrayVal[i] = val[i];
  }

  return arrayVal;
}

/*
 * Coerce values based the property types
 * @param {Object} where The where clause
 * @options {Object} [options] Optional options to use.
 * @property {Boolean} allowExtendedOperators.
 * @returns {Object} The coerced where clause
 * @private
 */
DataAccessObject._coerce = function(where, options) {
  const self = this;
  if (!where) {
    return where;
  }

  options = options || {};

  let err;
  if (typeof where !== 'object' || Array.isArray(where)) {
    err = new Error(g.f('The where clause %j is not an {{object}}', where));
    err.statusCode = 400;
    throw err;
  }

  const props = self.definition.properties;
  for (const p in where) {
    // Handle logical operators
    if (p === 'and' || p === 'or' || p === 'nor') {
      let clauses = where[p];
      try {
        clauses = coerceArray(clauses);
      } catch (e) {
        err = new Error(g.f('The %s operator has invalid clauses %j: %s', p, clauses, e.message));
        err.statusCode = 400;
        throw err;
      }

      for (let k = 0; k < clauses.length; k++) {
        self._coerce(clauses[k], options);
      }

      continue;
    }
    let DataType = props[p] && props[p].type;
    if (!DataType) {
      continue;
    }
    if (Array.isArray(DataType) || DataType === Array) {
      DataType = DataType[0];
    }
    if (DataType === Date) {
      DataType = DateType;
    } else if (DataType === Boolean) {
      DataType = BooleanType;
    } else if (DataType === Number) {
      // This fixes a regression in mongodb connector
      // For numbers, only convert it produces a valid number
      // LoopBack by default injects a number id. We should fix it based
      // on the connector's input, for example, MongoDB should use string
      // while RDBs typically use number
      DataType = NumberType;
    }

    if (!DataType) {
      continue;
    }

    if (DataType.prototype instanceof BaseModel) {
      continue;
    }

    if (DataType === geo.GeoPoint) {
      // Skip the GeoPoint as the near operator breaks the assumption that
      // an operation has only one property
      // We should probably fix it based on
      // http://docs.mongodb.org/manual/reference/operator/query/near/
      // The other option is to make operators start with $
      continue;
    }

    let val = where[p];
    if (val === null || val === undefined) {
      continue;
    }
    // Check there is an operator
    let operator = null;
    const exp = val;
    if (val.constructor === Object) {
      for (const op in operators) {
        if (op in val) {
          val = val[op];
          operator = op;
          switch (operator) {
            case 'inq':
            case 'nin':
            case 'between':
              try {
                val = coerceArray(val);
              } catch (e) {
                err = new Error(g.f('The %s property has invalid clause %j: %s', p, where[p], e));
                err.statusCode = 400;
                throw err;
              }

              if (operator === 'between' && val.length !== 2) {
                err = new Error(g.f(
                  'The %s property has invalid clause %j: Expected precisely 2 values, received %d',
                  p,
                  where[p],
                  val.length));
                err.statusCode = 400;
                throw err;
              }
              break;
            case 'like':
            case 'nlike':
            case 'ilike':
            case 'nilike':
              if (!(typeof val === 'string' || val instanceof RegExp)) {
                err = new Error(g.f(
                  'The %s property has invalid clause %j: Expected a string or RegExp',
                  p,
                  where[p]));
                err.statusCode = 400;
                throw err;
              }
              break;
            case 'regexp':
              val = utils.toRegExp(val);
              if (val instanceof Error) {
                val.statusCode = 400;
                throw err;
              }
              break;
          }
          break;
        }
      }
    }

    try {
      // Coerce val into an array if it resembles an array-like object
      val = coerceArray(val);
    } catch (e) {
      // NOOP when not coercable into an array.
    }

    // Coerce the array items
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        if (val[i] !== null && val[i] !== undefined) {
          if (!(val[i] instanceof RegExp)) {
            val[i] = DataType(val[i]);
          }
        }
      }
    } else if (val != null) {
      const allowExtendedOperators = self._allowExtendedOperators(options);
      if (operator === null && val instanceof RegExp) {
          // Normalize {name: /A/} to {name: {regexp: /A/}}
        operator = 'regexp';
      } else if (operator === 'regexp' && val instanceof RegExp) {
          // Do not coerce regex literals/objects
      } else if ((operator === 'like' || operator === 'nlike' ||
            operator === 'ilike' || operator === 'nilike') && val instanceof RegExp) {
          // Do not coerce RegExp operator value
      } else if (allowExtendedOperators && typeof val === 'object') {
          // Do not coerce object values when extended operators are allowed
      } else {
        val = DataType(val);
      }
    }
    // Rebuild {property: {operator: value}}
    if (operator) {
      const value = {};
      value[operator] = val;
      if (exp.options) {
        // Keep options for operators
        value.options = exp.options;
      }
      val = value;
    }
    where[p] = val;
  }
  return where;
};

/**
 * Find all instances of Model that match the specified query.
 * Fields used for filter and sort should be declared with `{index: true}` in model definition.
 * See [Querying models](http://docs.strongloop.com/display/DOC/Querying+models) for more information.
 *
 * For example, find the second page of ten users over age 21 in descending order exluding the password property.
 *
 * ```js
 * User.find({
 *   where: {
 *     age: {gt: 21}},
 *     order: 'age DESC',
 *     limit: 10,
 *     skip: 10,
 *     fields: {password: false}
 *   },
 *   console.log
 * );
 * ```
 *
 * @options {Object} [query] Optional JSON object that specifies query criteria and parameters.
 * @property {Object} where Search criteria in JSON format `{ key: val, key2: {gt: 'val2'}}`.
 * Operations:
 * - gt: >
 * - gte: >=
 * - lt: <
 * - lte: <=
 * - between
 * - inq: IN
 * - nin: NOT IN
 * - neq: !=
 * - like: LIKE
 * - nlike: NOT LIKE
 * - ilike: ILIKE
 * - nilike: NOT ILIKE
 * - regexp: REGEXP
 *
 * You can also use `and` and `or` operations.  See [Querying models](http://docs.strongloop.com/display/DOC/Querying+models) for more information.
 * @property {String|Object|Array} include Allows you to load relations of several objects and optimize numbers of requests.
 * Format examples;
 * - `'posts'`: Load posts
 * - `['posts', 'passports']`: Load posts and passports
 * - `{'owner': 'posts'}`: Load owner and owner's posts
 * - `{'owner': ['posts', 'passports']}`: Load owner, owner's posts, and owner's passports
 * - `{'owner': [{posts: 'images'}, 'passports']}`: Load owner, owner's posts, owner's posts' images, and owner's passports
 * See `DataAccessObject.include()`.
 * @property {String} order Sort order.  Format: `'key1 ASC, key2 DESC'`
 * @property {Number} limit Maximum number of instances to return.
 * @property {Number} skip Number of instances to skip.
 * @property {Number} offset Alias for `skip`.
 * @property {Object|Array|String} fields Included/excluded fields.
 * - `['foo']` or `'foo'` - include only the foo property
 *  - `['foo', 'bar']` - include the foo and bar properties.  Format:
 *  - `{foo: true}` - include only foo
 * - `{bat: false}` - include all properties, exclude bat
 *
 * @param {Function} cb Optional callback function.  Call this function with two arguments: `err` (null or Error) and an array of instances.
 * @return {Promise} results If no callback function is provided, a promise (which resolves to an array of instances) is returned
 */

DataAccessObject.find = function find(query, options, cb) {
  const connectionPromise = stillConnecting(this.getDataSource(), this, arguments);
  if (connectionPromise) {
    return connectionPromise;
  }

  if (options === undefined && cb === undefined) {
    if (typeof query === 'function') {
      // find(cb);
      cb = query;
      query = {};
    }
  } else if (cb === undefined) {
    if (typeof options === 'function') {
      // find(query, cb);
      cb = options;
      options = {};
    }
  }

  cb = cb || utils.createPromiseCallback();
  query = query || {};
  options = options || {};

  assert(typeof query === 'object', 'The query argument must be an object');
  assert(typeof options === 'object', 'The options argument must be an object');
  assert(typeof cb === 'function', 'The cb argument must be a function');

  const hookState = {};
  const self = this;
  const connector = self.getConnector();

  assert(typeof connector.all === 'function',
    'all() must be implemented by the connector');

  try {
    this._normalize(query, options);
  } catch (err) {
    process.nextTick(() => {
      cb(err);
    });
    return cb.promise;
  }

  this.applyScope(query);

  const near = query && geo.nearFilter(query.where);
  const supportsGeo = !!connector.buildNearFilter;

  if (near) {
    if (supportsGeo) {
      // convert it
      connector.buildNearFilter(query, near);
    } else if (query.where) {
      // do in memory query
      // using all documents
      // TODO [fabien] use default scope here?
      if (options.notify === false) {
        queryGeo(query);
      } else {
        withNotifyGeo();
      }

      function withNotifyGeo() {
        const context = {
          Model: self,
          query,
          hookState,
          options,
        };
        self.notifyObserversOf('access', context, (err, ctx) => {
          if (err) return cb(err);
          queryGeo(ctx.query);
        });
      }

      function queryGeo(query) {
        function geoCallbackWithoutNotify(err, data) {
          const memory = new Memory();
          const modelName = self.modelName;

          if (err) {
            cb(err);
          } else if (Array.isArray(data)) {
            memory.define({
              properties: self.dataSource.definitions[self.modelName].properties,
              settings: self.dataSource.definitions[self.modelName].settings,
              model: self,
            });

            data.forEach((obj) => {
              memory.create(modelName, obj, options, () => {
                // noop
              });
            });

            // FIXME: apply "includes" and other transforms - see allCb below
            memory.all(modelName, query, options, cb);
          } else {
            cb(null, []);
          }
        }

        function geoCallbackWithNotify(err, data) {
          if (err) return cb(err);

          async.map(data, (item, next) => {
            const context = {
              Model: self,
              data: item,
              isNewInstance: false,
              hookState,
              options,
            };

            self.notifyObserversOf('loaded', context, (err) => {
              if (err) return next(err);
              next(null, context.data);
            });
          }, (err, results) => {
            if (err) return cb(err);
            geoCallbackWithoutNotify(null, results);
          });
        }

        const geoCallback = options.notify === false ? geoCallbackWithoutNotify : geoCallbackWithNotify;
        if (connector.all.length === 4) {
          connector.all(self.modelName, {}, options, geoCallback);
        } else {
          connector.all(self.modelName, {}, geoCallback);
        }
      }
      // already handled
      return cb.promise;
    }
  }

  const allCb = function(err, data) {
    if (!err && Array.isArray(data)) {
      async.map(data, (item, next) => {
        const Model = self.lookupModel(item);
        if (options.notify === false) {
          buildResult(item, next);
        } else {
          withNotify(item, next);
        }

        function buildResult(data, callback) {
          const ctorOpts = {
            fields: query.fields,
            applySetters: false,
            persisted: true,
          };
          let obj;
          try {
            obj = new Model(data, ctorOpts);
          } catch (err) {
            return callback(err);
          }

          if (query && query.include) {
            if (query.collect) {
              // The collect property indicates that the query is to return the
              // standalone items for a related model, not as child of the parent object
              // For example, article.tags
              obj = obj.__cachedRelations[query.collect];
              if (obj === null) {
                obj = undefined;
              }
            } else {
              // This handles the case to return parent items including the related
              // models. For example, Article.find({include: 'tags'}, ...);
              // Try to normalize the include
              const includes = Inclusion.normalizeInclude(query.include || []);
              includes.forEach((inc) => {
                let relationName = inc;
                if (utils.isPlainObject(inc)) {
                  relationName = Object.keys(inc)[0];
                }

                // Promote the included model as a direct property
                let included = obj.__cachedRelations[relationName];
                if (Array.isArray(included)) {
                  included = new List(included, null, obj);
                }
                if (included) obj.__data[relationName] = included;
              });
              delete obj.__data.__cachedRelations;
            }
          }

          callback(null, obj);
        }

        function withNotify(data, callback) {
          const context = {
            Model,
            data,
            isNewInstance: false,
            hookState,
            options,
          };

          Model.notifyObserversOf('loaded', context, (err) => {
            if (err) return callback(err);
            buildResult(context.data, callback);
          });
        }
      },
      (err, results) => {
        if (err) return cb(err);

        // When applying query.collect, some root items may not have
        // any related/linked item. We store `undefined` in the results
        // array in such case, which is not desirable from API consumer's
        // point of view.
        results = results.filter(isDefined);

        if (data && data.countBeforeLimit) {
          results.countBeforeLimit = data.countBeforeLimit;
        }
        if (!supportsGeo && near) {
          results = geo.filter(results, near);
        }

        cb(err, results);
      });
    } else {
      cb(err, data || []);
    }
  };

  if (options.notify === false) {
    if (connector.all.length === 4) {
      connector.all(self.modelName, query, options, allCb);
    } else {
      connector.all(self.modelName, query, allCb);
    }
  } else {
    const context = {
      Model: this,
      query,
      hookState,
      options,
    };
    this.notifyObserversOf('access', context, (err, ctx) => {
      if (err) return cb(err);

      connector.all.length === 4 ?
        connector.all(self.modelName, ctx.query, options, allCb) :
        connector.all(self.modelName, ctx.query, allCb);
    });
  }
  return cb.promise;
};

function isDefined(value) {
  return value !== undefined;
}

/**
 * Find one record, same as `find`, but limited to one result. This function returns an object, not a collection.
 *
 * @param {Object} query Search conditions.  See [find](#dataaccessobjectfindquery-callback) for query format.
 * For example: `{where: {test: 'me'}}`.
 * @param {Object} [options] Options
 * @param {Function} cb Callback function called with (err, instance)
 */
DataAccessObject.findOne = function findOne(query, options, cb) {
  const connectionPromise = stillConnecting(this.getDataSource(), this, arguments);
  if (connectionPromise) {
    return connectionPromise;
  }

  if (options === undefined && cb === undefined) {
    if (typeof query === 'function') {
      cb = query;
      query = {};
    }
  } else if (cb === undefined) {
    if (typeof options === 'function') {
      cb = options;
      options = {};
    }
  }

  cb = cb || utils.createPromiseCallback();
  query = query || {};
  options = options || {};

  assert(typeof query === 'object', 'The query argument must be an object');
  assert(typeof options === 'object', 'The options argument must be an object');
  assert(typeof cb === 'function', 'The cb argument must be a function');

  query.limit = 1;
  this.find(query, options, (err, collection) => {
    if (err || !collection || !collection.length > 0) return cb(err, null);
    cb(err, collection[0]);
  });
  return cb.promise;
};

/**
 * Destroy all matching records.
 * Delete all model instances from data source. Note: destroyAll method does not destroy hooks.
 * Example:
 *````js
 * Product.destroyAll({price: {gt: 99}}, function(err) {
   // removed matching products
 * });
 * ````
 *
 * @param {Object} [where] Optional object that defines the criteria.  This is a "where" object. Do NOT pass a filter object.
 * @param {Object) [options] Options
 * @param {Function} [cb] Callback called with (err, info)
 */
DataAccessObject.remove =
DataAccessObject.deleteAll =
DataAccessObject.destroyAll = function destroyAll(where, options, cb) {
  const connectionPromise = stillConnecting(this.getDataSource(), this, arguments);
  if (connectionPromise) {
    return connectionPromise;
  }

  const Model = this;
  const connector = Model.getConnector();

  assert(typeof connector.destroyAll === 'function',
    'destroyAll() must be implemented by the connector');

  if (options === undefined && cb === undefined) {
    if (typeof where === 'function') {
      cb = where;
      where = {};
    }
  } else if (cb === undefined) {
    if (typeof options === 'function') {
      cb = options;
      options = {};
    }
  }

  cb = cb || utils.createPromiseCallback();
  where = where || {};
  options = options || {};

  assert(typeof where === 'object', 'The where argument must be an object');
  assert(typeof options === 'object', 'The options argument must be an object');
  assert(typeof cb === 'function', 'The cb argument must be a function');

  const hookState = {};

  let query = {where};
  this.applyScope(query);
  where = query.where;

  if (options.notify === false) {
    doDelete(where);
  } else {
    query = {where: whereIsEmpty(where) ? {} : where};
    const context = {
      Model,
      query,
      hookState,
      options,
    };
    Model.notifyObserversOf('access', context, (err, ctx) => {
      if (err) return cb(err);
      const context = {
        Model,
        where: ctx.query.where,
        hookState,
        options,
      };
      Model.notifyObserversOf('before delete', context, (err, ctx) => {
        if (err) return cb(err);
        doDelete(ctx.where);
      });
    });
  }

  function doDelete(where) {
    const context = {
      Model,
      where: whereIsEmpty(where) ? {} : where,
      hookState,
      options,
    };

    if (whereIsEmpty(where)) {
      if (connector.destroyAll.length === 4) {
        connector.destroyAll(Model.modelName, {}, options, done);
      } else {
        connector.destroyAll(Model.modelName, {}, done);
      }
    } else {
      try {
        // Support an optional where object
        where = removeUndefined(where);
        where = Model._coerce(where, options);
      } catch (err) {
        return process.nextTick(() => {
          cb(err);
        });
      }

      if (connector.destroyAll.length === 4) {
        connector.destroyAll(Model.modelName, where, options, done);
      } else {
        connector.destroyAll(Model.modelName, where, done);
      }
    }

    function done(err, info) {
      if (err) return cb(err);

      if (options.notify === false) {
        return cb(err, info);
      }

      const context = {
        Model,
        where,
        hookState,
        options,
        info,
      };
      Model.notifyObserversOf('after delete', context, (err) => {
        cb(err, info);
      });
    }
  }
  return cb.promise;
};

function whereIsEmpty(where) {
  return !where ||
     (typeof where === 'object' && Object.keys(where).length === 0);
}

/**
 * Delete the record with the specified ID.
 * Aliases are `destroyById` and `deleteById`.
 * @param {*} id The id value
 * @param {Function} cb Callback called with (err)
 */

// [FIXME] rfeng: This is a hack to set up 'deleteById' first so that
// 'deleteById' will be used as the name for strong-remoting to keep it backward
// compatible for angular SDK
DataAccessObject.removeById =
DataAccessObject.destroyById =
DataAccessObject.deleteById = function deleteById(id, options, cb) {
  const connectionPromise = stillConnecting(this.getDataSource(), this, arguments);
  if (connectionPromise) {
    return connectionPromise;
  }

  assert(arguments.length >= 1, 'The id argument is required');
  if (cb === undefined) {
    if (typeof options === 'function') {
      // destroyById(id, cb)
      cb = options;
      options = {};
    }
  }

  options = options || {};
  cb = cb || utils.createPromiseCallback();

  assert(typeof options === 'object', 'The options argument must be an object');
  assert(typeof cb === 'function', 'The cb argument must be a function');

  if (isPKMissing(this, cb)) {
    return cb.promise;
  } else if (id == null || id === '') {
    process.nextTick(() => {
      cb(new Error(g.f('{{Model::deleteById}} requires the {{id}} argument')));
    });
    return cb.promise;
  }

  const Model = this;

  this.remove(byIdQuery(this, id).where, options, (err, info) => {
    if (err) return cb(err);
    const deleted = info && info.count > 0;
    if (Model.settings.strictDelete && !deleted) {
      err = new Error(g.f('No instance with {{id}} %s found for %s', id, Model.modelName));
      err.code = 'NOT_FOUND';
      err.statusCode = 404;
      return cb(err);
    }

    cb(null, info);
  });
  return cb.promise;
};

/**
 * Return count of matched records. Optional query parameter allows you to count filtered set of model instances.
 * Example:
 *
 *```js
 * User.count({approved: true}, function(err, count) {
 *     console.log(count); // 2081
 * });
 * ```
 *
 * @param {Object} [where] Search conditions (optional)
 * @param {Object} [options] Options
 * @param {Function} cb Callback, called with (err, count)
 */
DataAccessObject.count = function(where, options, cb) {
  const connectionPromise = stillConnecting(this.getDataSource(), this, arguments);
  if (connectionPromise) {
    return connectionPromise;
  }

  if (options === undefined && cb === undefined) {
    if (typeof where === 'function') {
      // count(cb)
      cb = where;
      where = {};
    }
  } else if (cb === undefined) {
    if (typeof options === 'function') {
      // count(where, cb)
      cb = options;
      options = {};
    }
  }

  cb = cb || utils.createPromiseCallback();
  where = where || {};
  options = options || {};

  assert(typeof where === 'object', 'The where argument must be an object');
  assert(typeof options === 'object', 'The options argument must be an object');
  assert(typeof cb === 'function', 'The cb argument must be a function');

  const Model = this;
  const connector = Model.getConnector();
  assert(typeof connector.count === 'function',
    'count() must be implemented by the connector');
  assert(connector.count.length >= 3,
    'count() must take at least 3 arguments');

  const hookState = {};

  const query = {where};
  this.applyScope(query);
  where = query.where;

  try {
    where = removeUndefined(where);
    where = this._coerce(where, options);
  } catch (err) {
    process.nextTick(() => {
      cb(err);
    });
    return cb.promise;
  }

  const context = {
    Model,
    query: {where},
    hookState,
    options,
  };
  this.notifyObserversOf('access', context, (err, ctx) => {
    if (err) return cb(err);
    where = ctx.query.where;

    if (connector.count.length <= 3) {
      // Old signature, please note where is the last
      // count(model, cb, where)
      connector.count(Model.modelName, cb, where);
    } else {
      // New signature
      // count(model, where, options, cb)
      connector.count(Model.modelName, where, options, cb);
    }
  });
  return cb.promise;
};

/**
 * Save instance. If the instance does not have an ID, call `create` instead.
 * Triggers: validate, save, update or create.
 * @options {Object} options Optional options to use.
 * @property {Boolean} validate Default is true.
 * @property {Boolean} throws  Default is false.
 * @param {Function} cb Callback function with err and object arguments
 */
DataAccessObject.prototype.save = function(options, cb) {
  const connectionPromise = stillConnecting(this.getDataSource(), this, arguments);
  if (connectionPromise) {
    return connectionPromise;
  }
  const Model = this.constructor;

  if (typeof options === 'function') {
    cb = options;
    options = {};
  }

  cb = cb || utils.createPromiseCallback();
  options = options || {};

  assert(typeof options === 'object', 'The options argument should be an object');
  assert(typeof cb === 'function', 'The cb argument should be a function');

  if (isPKMissing(Model, cb)) {
    return cb.promise;
  } else if (this.isNewRecord()) {
    return Model.create(this, options, cb);
  }

  const hookState = {};

  if (options.validate === undefined) {
    if (Model.settings.automaticValidation === undefined) {
      options.validate = true;
    } else {
      options.validate = Model.settings.automaticValidation;
    }
  }

  if (options.throws === undefined) {
    options.throws = false;
  }

  const inst = this;
  const connector = inst.getConnector();
  const modelName = Model.modelName;

  let context = {
    Model,
    instance: inst,
    hookState,
    options,
  };
  Model.notifyObserversOf('before save', context, (err) => {
    if (err) return cb(err);

    let data = inst.toObject(true);
    Model.applyProperties(data, inst);
    inst.setAttributes(data);

    // validate first
    if (!options.validate) {
      return save();
    }

    inst.isValid((valid) => {
      if (valid) {
        save();
      } else {
        const err = new ValidationError(inst);
        // throws option is dangerous for async usage
        if (options.throws) {
          throw err;
        }
        cb(err, inst);
      }
    }, data, options);

    // then save
    function save() {
      inst.trigger('save', (saveDone) => {
        inst.trigger('update', (updateDone) => {
          data = removeUndefined(data);
          function saveCallback(err, unusedData, result) {
            if (err) {
              return cb(err, inst);
            }

            const context = {
              Model,
              data,
              isNewInstance: result && result.isNewInstance,
              hookState,
              options,
            };
            Model.notifyObserversOf('loaded', context, (err) => {
              if (err) return cb(err);

              inst._initProperties(data, {persisted: true});

              const context = {
                Model,
                instance: inst,
                isNewInstance: result && result.isNewInstance,
                hookState,
                options,
              };
              Model.notifyObserversOf('after save', context, (err) => {
                if (err) return cb(err, inst);
                updateDone.call(inst, () => {
                  saveDone.call(inst, () => {
                    cb(err, inst);
                  });
                });
              });
            });
          }

          context = {
            Model,
            data,
            where: byIdQuery(Model, getIdValue(Model, inst)).where,
            currentInstance: inst,
            hookState,
            options,
          };

          Model.notifyObserversOf('persist', context, (err) => {
            if (err) return cb(err);

            if (connector.save.length === 4) {
              connector.save(modelName, inst.constructor._forDB(data), options, saveCallback);
            } else {
              connector.save(modelName, inst.constructor._forDB(data), saveCallback);
            }
          });
        }, data, cb);
      }, data, cb);
    }
  });
  return cb.promise;
};

/**
 * Update multiple instances that match the where clause
 *
 * Example:
 *
 *```js
 * Employee.update({managerId: 'x001'}, {managerId: 'x002'}, function(err) {
 *     ...
 * });
 * ```
 *
 * @param {Object} [where] Search conditions (optional)
 * @param {Object} data Changes to be made
 * @param {Object} [options] Options for update
 * @param {Function} cb Callback, called with (err, info)
 */
DataAccessObject.update =
DataAccessObject.updateAll = function(where, data, options, cb) {
  const connectionPromise = stillConnecting(this.getDataSource(), this, arguments);
  if (connectionPromise) {
    return connectionPromise;
  }

  assert(arguments.length >= 1, 'At least one argument is required');

  if (data === undefined && options === undefined && cb === undefined && arguments.length === 1) {
    data = where;
    where = {};
  } else if (options === undefined && cb === undefined) {
    // One of:
    // updateAll(data, cb)
    // updateAll(where, data) -> Promise
    if (typeof data === 'function') {
      cb = data;
      data = where;
      where = {};
    }
  } else if (cb === undefined) {
    // One of:
    // updateAll(where, data, options) -> Promise
    // updateAll(where, data, cb)
    if (typeof options === 'function') {
      cb = options;
      options = {};
    }
  }

  data = data || {};
  options = options || {};
  cb = cb || utils.createPromiseCallback();

  assert(typeof where === 'object', 'The where argument must be an object');
  assert(typeof data === 'object', 'The data argument must be an object');
  assert(typeof options === 'object', 'The options argument must be an object');
  assert(typeof cb === 'function', 'The cb argument must be a function');

  const Model = this;
  const connector = Model.getDataSource().connector;
  assert(typeof connector.update === 'function',
    'update() must be implemented by the connector');

  const hookState = {};

  const query = {where};
  this.applyScope(query);
  this.applyProperties(data);

  where = query.where;

  const context = {
    Model,
    query: {where},
    hookState,
    options,
  };
  Model.notifyObserversOf('access', context, (err, ctx) => {
    if (err) return cb(err);
    const context = {
      Model,
      where: ctx.query.where,
      data,
      hookState,
      options,
    };
    Model.notifyObserversOf('before save', context,
      (err, ctx) => {
        if (err) return cb(err);
        doUpdate(ctx.where, ctx.data);
      });
  });

  function doUpdate(where, data) {
    try {
      where = removeUndefined(where);
      where = Model._coerce(where, options);
      data = removeUndefined(data);
      data = Model._coerce(data, options);
    } catch (err) {
      return process.nextTick(() => {
        cb(err);
      });
    }

    function updateCallback(err, info) {
      if (err) return cb(err);

      const context = {
        Model,
        where,
        data,
        hookState,
        options,
        info,
      };
      Model.notifyObserversOf('after save', context, (err, ctx) => cb(err, info));
    }

    const context = {
      Model,
      where,
      data,
      hookState,
      options,
    };
    Model.notifyObserversOf('persist', context, (err, ctx) => {
      if (err) return cb(err);

      if (connector.update.length === 5) {
        connector.update(Model.modelName, where, data, options, updateCallback);
      } else {
        connector.update(Model.modelName, where, data, updateCallback);
      }
    });
  }
  return cb.promise;
};

DataAccessObject.prototype.isNewRecord = function() {
  return !this.__persisted;
};

/**
 * Return connector of current record
 * @private
 */
DataAccessObject.prototype.getConnector = function() {
  return this.getDataSource().connector;
};

/**
 * Delete object from persistence
 *
 * Triggers `destroy` hook (async) before and after destroying object
 *
 * @param {Object} [options] Options for delete
 * @param {Function} cb Callback
 */
DataAccessObject.prototype.remove =
  DataAccessObject.prototype.delete =
    DataAccessObject.prototype.destroy = function(options, cb) {
      const connectionPromise = stillConnecting(this.getDataSource(), this, arguments);
      if (connectionPromise) {
        return connectionPromise;
      }

      if (cb === undefined && typeof options === 'function') {
        cb = options;
        options = {};
      }

      cb = cb || utils.createPromiseCallback();
      options = options || {};

      assert(typeof options === 'object', 'The options argument should be an object');
      assert(typeof cb === 'function', 'The cb argument should be a function');

      const inst = this;
      const connector = this.getConnector();

      const Model = this.constructor;
      const id = getIdValue(this.constructor, this);
      const hookState = {};

      if (isPKMissing(Model, cb)) { return cb.promise; }

      const context = {
        Model,
        query: byIdQuery(Model, id),
        hookState,
        options,
      };

      Model.notifyObserversOf('access', context, (err, ctx) => {
        if (err) return cb(err);
        const context = {
          Model,
          where: ctx.query.where,
          instance: inst,
          hookState,
          options,
        };
        Model.notifyObserversOf('before delete', context, (err, ctx) => {
          if (err) return cb(err);
          doDeleteInstance(ctx.where);
        });
      });

      function doDeleteInstance(where) {
        if (!isWhereByGivenId(Model, where, id)) {
          // A hook modified the query, it is no longer
          // a simple 'delete model with the given id'.
          // We must switch to full query-based delete.
          Model.deleteAll(where, {notify: false}, (err, info) => {
            if (err) return cb(err, false);
            const deleted = info && info.count > 0;
            if (Model.settings.strictDelete && !deleted) {
              err = new Error(g.f('No instance with {{id}} %s found for %s', id, Model.modelName));
              err.code = 'NOT_FOUND';
              err.statusCode = 404;
              return cb(err, false);
            }
            const context = {
              Model,
              where,
              instance: inst,
              hookState,
              options,
              info,
            };
            Model.notifyObserversOf('after delete', context, (err) => {
              cb(err, info);
            });
          });
          return;
        }

        inst.trigger('destroy', (destroyed) => {
          function destroyCallback(err, info) {
            if (err) return cb(err);
            const deleted = info && info.count > 0;
            if (Model.settings.strictDelete && !deleted) {
              err = new Error(g.f('No instance with {{id}} %s found for %s', id, Model.modelName));
              err.code = 'NOT_FOUND';
              err.statusCode = 404;
              return cb(err);
            }

            destroyed(() => {
              const context = {
                Model,
                where,
                instance: inst,
                hookState,
                options,
                info,
              };
              Model.notifyObserversOf('after delete', context, (err) => {
                cb(err, info);
              });
            });
          }

          if (connector.destroy.length === 4) {
            connector.destroy(inst.constructor.modelName, id, options, destroyCallback);
          } else {
            connector.destroy(inst.constructor.modelName, id, destroyCallback);
          }
        }, null, cb);
      }
      return cb.promise;
    };

/**
 * Set a single attribute.
 * Equivalent to `setAttributes({name: value})`
 *
 * @param {String} name Name of property
 * @param {Mixed} value Value of property
 */
DataAccessObject.prototype.setAttribute = function setAttribute(name, value) {
  this[name] = value; // TODO [fabien] - currently not protected by applyProperties
};

/**
 * Update a single attribute.
 * Equivalent to `updateAttributes({name: value}, cb)`
 *
 * @param {String} name Name of property
 * @param {Mixed} value Value of property
 * @param {Function} cb Callback function called with (err, instance)
 */
DataAccessObject.prototype.updateAttribute = function updateAttribute(name, value, options, cb) {
  const data = {};
  data[name] = value;
  return this.updateAttributes(data, options, cb);
};

/**
 * Update set of attributes.
 *
 * @trigger `change` hook
 * @param {Object} data Data to update
 */
DataAccessObject.prototype.setAttributes = function setAttributes(data) {
  if (typeof data !== 'object') return;

  this.constructor.applyProperties(data, this);

  const Model = this.constructor;
  const inst = this;

  // update instance's properties
  for (const key in data) {
    inst.setAttribute(key, data[key]);
  }

  Model.emit('set', inst);
};

DataAccessObject.prototype.unsetAttribute = function unsetAttribute(name, nullify) {
  if (nullify || this.constructor.definition.settings.persistUndefinedAsNull) {
    this[name] = this.__data[name] = null;
  } else {
    delete this[name];
    delete this.__data[name];
  }
};

/**
 * Replace set of attributes.
 * Performs validation before replacing.
 *
 * @trigger `validation`, `save` and `update` hooks
 * @param {Object} data Data to replace
 * @param {Object} [options] Options for replace
 * @param {Function} cb Callback function called with (err, instance)
 */
DataAccessObject.prototype.replaceAttributes = function(data, options, cb) {
  const Model = this.constructor;
  const id = getIdValue(this.constructor, this);
  return Model.replaceById(id, data, options, cb);
};

DataAccessObject.replaceById = function(id, data, options, cb) {
  const connectionPromise = stillConnecting(this.getDataSource(), this, arguments);
  if (connectionPromise) {
    return connectionPromise;
  }

  if (cb === undefined) {
    if (typeof options === 'function') {
      cb = options;
      options = {};
    }
  }

  cb = cb || utils.createPromiseCallback();
  options = options || {};

  assert((typeof data === 'object') && (data !== null),
          'The data argument must be an object');
  assert(typeof options === 'object', 'The options argument must be an object');
  assert(typeof cb === 'function', 'The cb argument must be a function');

  const connector = this.getConnector();

  let err;
  if (typeof connector.replaceById !== 'function') {
    err = new Error(g.f(
      'The connector %s does not support {{replaceById}} operation. This is not a bug in LoopBack. ' +
      'Please contact the authors of the connector, preferably via GitHub issues.',
      connector.name));
    return cb(err);
  }

  const pkName = idName(this);
  if (!data[pkName]) data[pkName] = id;

  let Model = this;
  let inst = new Model(data, {persisted: true});
  const enforced = {};
  this.applyProperties(enforced, inst);
  inst.setAttributes(enforced);
  Model = this.lookupModel(data); // data-specific
  if (Model !== inst.constructor) inst = new Model(data);
  const strict = inst.__strict;

  if (isPKMissing(Model, cb)) { return cb.promise; }

  const model = Model.modelName;
  const hookState = {};

  if (id !== data[pkName]) {
    err = new Error(g.f('{{id}} property (%s) ' +
            'cannot be updated from %s to %s', pkName, id, data[pkName]));
    err.statusCode = 400;
    process.nextTick(() => { cb(err); });
    return cb.promise;
  }

  const context = {
    Model,
    instance: inst,
    isNewInstance: false,
    hookState,
    options,
  };

  Model.notifyObserversOf('before save', context, (err, ctx) => {
    if (err) return cb(err);

    if (ctx.instance[pkName] !== id && !Model._warned.cannotOverwritePKInBeforeSaveHook) {
      Model._warned.cannotOverwritePKInBeforeSaveHook = true;
      g.warn('WARNING: {{id}} property cannot be changed from %s to %s for model:%s ' +
        'in {{\'before save\'}} operation hook', id, inst[pkName], Model.modelName);
    }

    data = inst.toObject(false);

    if (strict) {
      applyStrictCheck(Model, strict, data, inst, validateAndCallConnector);
    } else {
      validateAndCallConnector(null, data);
    }

    function validateAndCallConnector(err, data) {
      if (err) return cb(err);
      data = removeUndefined(data);
      // update instance's properties
      inst.setAttributes(data);

      let doValidate = true;
      if (options.validate === undefined) {
        if (Model.settings.automaticValidation !== undefined) {
          doValidate = Model.settings.automaticValidation;
        }
      } else {
        doValidate = options.validate;
      }

      if (doValidate) {
        inst.isValid((valid) => {
          if (!valid) return cb(new ValidationError(inst), inst);

          callConnector();
        }, data, options);
      } else {
        callConnector();
      }

      function callConnector() {
        copyData(data, inst);
        const typedData = convertSubsetOfPropertiesByType(inst, data);
        context.data = typedData;

        function replaceCallback(err, data) {
          if (err) return cb(err);

          const ctx = {
            Model,
            hookState,
            data: context.data,
            isNewInstance: false,
            options,
          };
          Model.notifyObserversOf('loaded', ctx, (err) => {
            if (err) return cb(err);

            if (ctx.data[pkName] !== id && !Model._warned.cannotOverwritePKInLoadedHook) {
              Model._warned.cannotOverwritePKInLoadedHook = true;
              g.warn('WARNING: {{id}} property cannot be changed from %s to %s for model:%s in ' +
                '{{\'loaded\'}} operation hook',
                id, ctx.data[pkName], Model.modelName);
            }

            inst.__persisted = true;
            ctx.data[pkName] = id;
            inst.setAttributes(ctx.data);

            const context = {
              Model,
              instance: inst,
              isNewInstance: false,
              hookState,
              options,
            };
            Model.notifyObserversOf('after save', context, (err) => {
              cb(err, inst);
            });
          });
        }

        const ctx = {
          Model,
          where: byIdQuery(Model, id).where,
          data: context.data,
          isNewInstance: false,
          currentInstance: inst,
          hookState,
          options,
        };
        Model.notifyObserversOf('persist', ctx, (err) => {
          connector.replaceById(model, id,
            inst.constructor._forDB(context.data), options, replaceCallback);
        });
      }
    }
  });
  return cb.promise;
};

/**
 * Update set of attributes.
 * Performs validation before updating.
 * NOTE: `patchOrCreate` is an alias.
 *
 * @trigger `validation`, `save` and `update` hooks
 * @param {Object} data Data to update
 * @param {Object} [options] Options for updateAttributes
 * @param {Function} cb Callback function called with (err, instance)
 */
DataAccessObject.prototype.updateAttributes =
DataAccessObject.prototype.patchAttributes =
function(data, options, cb) {
  const self = this;
  const connectionPromise = stillConnecting(this.getDataSource(), this, arguments);
  if (connectionPromise) {
    return connectionPromise;
  }

  if (options === undefined && cb === undefined) {
    if (typeof data === 'function') {
      // updateAttributes(cb)
      cb = data;
      data = undefined;
    }
  } else if (cb === undefined) {
    if (typeof options === 'function') {
      // updateAttributes(data, cb)
      cb = options;
      options = {};
    }
  }

  cb = cb || utils.createPromiseCallback();
  options = options || {};

  assert((typeof data === 'object') && (data !== null),
    'The data argument must be an object');
  assert(typeof options === 'object', 'The options argument must be an object');
  assert(typeof cb === 'function', 'The cb argument must be a function');

  const inst = this;
  const Model = this.constructor;
  const connector = inst.getConnector();
  assert(typeof connector.updateAttributes === 'function',
    'updateAttributes() must be implemented by the connector');

  if (isPKMissing(Model, cb)) { return cb.promise; }

  const allowExtendedOperators = Model._allowExtendedOperators(options);
  const strict = this.__strict;
  const model = Model.modelName;
  const hookState = {};

  // Convert the data to be plain object so that update won't be confused
  if (data instanceof Model) {
    data = data.toObject(false);
  }
  data = removeUndefined(data);

  // Make sure id(s) cannot be changed
  const idNames = Model.definition.idNames();
  for (let i = 0, n = idNames.length; i < n; i++) {
    const idName = idNames[i];
    if (data[idName] !== undefined && !idEquals(data[idName], inst[idName])) {
      var err = new Error(g.f('{{id}} cannot be updated from ' +
        '%s to %s when {{forceId}} is set to true',
        inst[idName], data[idName]));
      err.statusCode = 400;
      process.nextTick(() => {
        cb(err);
      });
      return cb.promise;
    }
  }

  const context = {
    Model,
    where: byIdQuery(Model, getIdValue(Model, inst)).where,
    data,
    currentInstance: inst,
    hookState,
    options,
  };

  Model.notifyObserversOf('before save', context, (err, ctx) => {
    if (err) return cb(err);
    data = ctx.data;

    if (strict && !allowExtendedOperators) {
      applyStrictCheck(self.constructor, strict, data, inst, validateAndSave);
    } else {
      validateAndSave(null, data);
    }

    function validateAndSave(err, data) {
      if (err) return cb(err);
      data = removeUndefined(data);
      let doValidate = true;
      if (options.validate === undefined) {
        if (Model.settings.automaticValidation !== undefined) {
          doValidate = Model.settings.automaticValidation;
        }
      } else {
        doValidate = options.validate;
      }

      // update instance's properties
      try {
        inst.setAttributes(data);
      } catch (err) {
        return cb(err);
      }

      if (doValidate) {
        inst.isValid((valid) => {
          if (!valid) {
            cb(new ValidationError(inst), inst);
            return;
          }

          triggerSave();
        }, data, options);
      } else {
        triggerSave();
      }

      function triggerSave() {
        inst.trigger('save', (saveDone) => {
          inst.trigger('update', (done) => {
            copyData(data, inst);
            const typedData = convertSubsetOfPropertiesByType(inst, data);
            context.data = typedData;

            function updateAttributesCallback(err) {
              if (err) return cb(err);
              const ctx = {
                Model,
                data: context.data,
                hookState,
                options,
                isNewInstance: false,
              };
              Model.notifyObserversOf('loaded', ctx, (err) => {
                if (err) return cb(err);

                inst.__persisted = true;

                // By default, the instance passed to updateAttributes callback is NOT updated
                // with the changes made through persist/loaded hooks. To preserve
                // backwards compatibility, we introduced a new setting updateOnLoad,
                // which if set, will apply these changes to the model instance too.
                if (Model.settings.updateOnLoad) {
                  inst.setAttributes(ctx.data);
                }
                done.call(inst, () => {
                  saveDone.call(inst, () => {
                    if (err) return cb(err, inst);

                    const context = {
                      Model,
                      instance: inst,
                      isNewInstance: false,
                      hookState,
                      options,
                    };
                    Model.notifyObserversOf('after save', context, (err) => {
                      cb(err, inst);
                    });
                  });
                });
              });
            }

            const ctx = {
              Model,
              where: byIdQuery(Model, getIdValue(Model, inst)).where,
              data: context.data,
              currentInstance: inst,
              isNewInstance: false,
              hookState,
              options,
            };
            Model.notifyObserversOf('persist', ctx, (err) => {
              if (connector.updateAttributes.length === 5) {
                connector.updateAttributes(model, getIdValue(inst.constructor, inst),
                  inst.constructor._forDB(context.data), options, updateAttributesCallback);
              } else {
                connector.updateAttributes(model, getIdValue(inst.constructor, inst),
                  inst.constructor._forDB(context.data), updateAttributesCallback);
              }
            });
          }, data, cb);
        }, data, cb);
      }
    }
  });
  return cb.promise;
};

/**
 * Reload object from persistence
 * Requires `id` member of `object` to be able to call `find`
 * @param {Function} cb Called with (err, instance) arguments
 * @private
 */
DataAccessObject.prototype.reload = function reload(cb) {
  const connectionPromise = stillConnecting(this.getDataSource(), this, arguments);
  if (connectionPromise) {
    return connectionPromise;
  }

  return this.constructor.findById(getIdValue(this.constructor, this), cb);
};

/*
 * Define readonly property on object
 *
 * @param {Object} obj
 * @param {String} key
 * @param {Mixed} value
 * @private
 */
function defineReadonlyProp(obj, key, value) {
  Object.defineProperty(obj, key, {
    writable: false,
    enumerable: true,
    configurable: true,
    value,
  });
}

const defineScope = require('./scope.js').defineScope;

/**
 * Define a scope for the model class. Scopes enable you to specify commonly-used
 * queries that you can reference as method calls on a model.
 *
 * @param {String} name The scope name
 * @param {Object} query The query object for DataAccessObject.find()
 * @param {ModelClass} [targetClass] The model class for the query, default to
 * the declaring model
 */
DataAccessObject.scope = function(name, query, targetClass, methods, options) {
  let cls = this;
  if (options && options.isStatic === false) {
    cls = cls.prototype;
  }
  return defineScope(cls, targetClass || cls, name, query, methods, options);
};

/*
 * Add 'include'
 */
jutil.mixin(DataAccessObject, Inclusion);

/*
 * Add 'relation'
 */
jutil.mixin(DataAccessObject, Relation);

/*
 * Add 'transaction'
 */
jutil.mixin(DataAccessObject, require('./transaction'));

function PKMissingError(modelName) {
  this.name = 'PKMissingError';
  this.message = `Primary key is missing for the ${modelName} model`;
}
PKMissingError.prototype = new Error();

function isPKMissing(modelClass, cb) {
  const hasPK = modelClass.definition.hasPK();
  if (hasPK) return false;
  process.nextTick(() => {
    cb(new PKMissingError(modelClass.modelName));
  });
  return true;
}
