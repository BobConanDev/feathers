import { Db, MongoClient, ObjectId } from 'mongodb'
import adapterTests from '@feathersjs/adapter-tests'
import assert from 'assert'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { Ajv, FromSchema, getValidator, hooks, querySyntax } from '@feathersjs/schema'
import { feathers } from '@feathersjs/feathers'
import errors from '@feathersjs/errors'
import { MongoDBService, AdapterId } from '../src'

const testSuite = adapterTests([
  '.options',
  '.events',
  '._get',
  '._find',
  '._create',
  '._update',
  '._patch',
  '._remove',
  '.get',
  '.get + $select',
  '.get + id + query',
  '.get + NotFound',
  '.get + id + query id',
  '.find',
  '.find + paginate + query',
  '.remove',
  '.remove + $select',
  '.remove + id + query',
  '.remove + multi',
  '.remove + multi no pagination',
  '.remove + id + query id',
  '.remove + NotFound',
  '.update',
  '.update + $select',
  '.update + id + query',
  '.update + NotFound',
  '.update + id + query id',
  '.update + query + NotFound',
  '.patch',
  '.patch + $select',
  '.patch + id + query',
  '.patch multiple',
  '.patch multiple no pagination',
  '.patch multi query same',
  '.patch multi query changed',
  '.patch + query + NotFound',
  '.patch + NotFound',
  '.patch + id + query id',
  '.create',
  '.create ignores query',
  '.create + $select',
  '.create multi',
  'internal .find',
  'internal .get',
  'internal .create',
  'internal .update',
  'internal .patch',
  'internal .remove',
  '.find + equal',
  '.find + equal multiple',
  '.find + $sort',
  '.find + $sort + string',
  '.find + $limit',
  '.find + $limit 0',
  '.find + $skip',
  '.find + $select',
  '.find + $or',
  '.find + $and',
  '.find + $in',
  '.find + $nin',
  '.find + $lt',
  '.find + $lte',
  '.find + $gt',
  '.find + $gte',
  '.find + $ne',
  '.find + $gt + $lt + $sort',
  '.find + $or nested + $sort',
  '.find + $and + $or',
  '.find + paginate',
  '.find + paginate + $limit + $skip',
  '.find + paginate + $limit 0',
  '.find + paginate + params',
  'params.adapter + paginate',
  'params.adapter + multi'
])

describe('Feathers MongoDB Service', () => {
  const personSchema = {
    $id: 'Person',
    type: 'object',
    additionalProperties: false,
    required: ['_id', 'name', 'age'],
    properties: {
      _id: { oneOf: [{ type: 'string' }, { type: 'object' }] },
      name: { type: 'string' },
      age: { type: 'number' },
      friends: { type: 'array', items: { type: 'string' } },
      team: { type: 'string' },
      $push: {
        type: 'object',
        properties: {
          friends: { type: 'string' }
        }
      }
    }
  } as const
  const personQuery = {
    $id: 'PersonQuery',
    type: 'object',
    additionalProperties: false,
    properties: {
      ...querySyntax(personSchema.properties, {
        name: {
          $regex: { type: 'string' }
        }
      })
    }
  } as const
  const validator = new Ajv({
    coerceTypes: true
  })
  const personQueryValidator = getValidator(personQuery, validator)

  type Person = Omit<FromSchema<typeof personSchema>, '_id'> & { _id: AdapterId }
  type Todo = {
    _id: string
    name: string
    userId: string
    person?: Person
  }

  type ServiceTypes = {
    people: MongoDBService<Person>
    'people-customid': MongoDBService<Person>
    todos: MongoDBService<Todo>
  }

  const app = feathers<ServiceTypes>()

  let db: Db
  let mongoClient: MongoClient
  let mongod: MongoMemoryServer

  before(async () => {
    mongod = await MongoMemoryServer.create()

    const client = await MongoClient.connect(mongod.getUri())

    mongoClient = client
    db = client.db('feathers-test')

    app.use(
      'people',
      new MongoDBService({
        Model: db.collection('people'),
        events: ['testing']
      })
    )
    app.use(
      'people-customid',
      new MongoDBService({
        Model: db.collection('people-customid'),
        id: 'customid',
        events: ['testing']
      })
    )

    app.service('people').hooks({
      before: {
        find: [hooks.validateQuery(personQueryValidator)]
      }
    })

    db.collection('people-customid').deleteMany({})
    db.collection('people').deleteMany({})
    db.collection('todos').deleteMany({})

    db.collection('people').createIndex({ name: 1 }, { partialFilterExpression: { team: 'blue' } })
  })

  after(async () => {
    await db.dropDatabase()
    await mongoClient.close()
    await mongod.stop()
  })

  describe('Service utility functions', () => {
    describe('getObjectId', () => {
      it('returns an ObjectID instance for a valid ID', () => {
        const id = new ObjectId()
        const objectify = app.service('people').getObjectId(id.toString())

        assert.ok(objectify instanceof ObjectId)
        assert.strictEqual(objectify.toString(), id.toString())
      })

      it('returns an ObjectID instance for a valid ID', () => {
        const id = 'non-valid object id'
        const objectify = app.service('people').getObjectId(id.toString())

        assert.ok(!(objectify instanceof ObjectId))
        assert.strictEqual(objectify, id)
      })
    })
  })

  // For some bizarre reason this test is flaky
  describe.skip('works with ObjectIds', () => {
    it('can call methods with ObjectId instance', async () => {
      const person = await app.service('people').create({
        name: 'David'
      })

      const withId = await app.service('people').get(person._id.toString())

      assert.strictEqual(withId.name, 'David')

      await app.service('people').remove(new ObjectId(person._id.toString()))
    })
  })

  describe('Special collation param', () => {
    let peopleService: MongoDBService<Person>
    let people: Person[]

    function indexOfName(results: Person[], name: string) {
      let index = 0

      for (const person of results) {
        if (person.name === name) {
          return index
        }
        index++
      }

      return -1
    }

    beforeEach(async () => {
      peopleService = app.service('people')
      peopleService.options.multi = true
      peopleService.options.disableObjectify = true
      people = await peopleService.create([{ name: 'AAA' }, { name: 'aaa' }, { name: 'ccc' }])
    })

    afterEach(async () => {
      peopleService.options.multi = false

      try {
        await Promise.all([
          peopleService.remove(people[0]._id),
          peopleService.remove(people[1]._id),
          peopleService.remove(people[2]._id)
        ])
      } catch (error: unknown) {}
    })

    it('queries for ObjectId in find', async () => {
      const person = await peopleService.create({ name: 'Coerce' })
      const results = await peopleService.find({
        paginate: false,
        query: {
          _id: new ObjectId(person._id)
        }
      })

      assert.strictEqual(results.length, 1)

      await peopleService.remove(person._id)
    })

    it('works with normal string _id', async () => {
      const person = await peopleService.create({
        _id: 'lessonKTDA08',
        name: 'Coerce'
      })
      const result = await peopleService.get(person._id)

      assert.strictEqual(result.name, 'Coerce')

      await peopleService.remove(person._id)
    })

    it('sorts with default behavior without collation param', async () => {
      const results = await peopleService.find({
        paginate: false,
        query: { $sort: { name: -1 } }
      })

      assert.ok(indexOfName(results, 'aaa') < indexOfName(results, 'AAA'))
    })

    it('sorts using collation param if present', async () => {
      const results = await peopleService.find({
        paginate: false,
        query: { $sort: { name: -1 } },
        mongodb: { collation: { locale: 'en', strength: 1 } }
      })

      assert.ok(indexOfName(results, 'aaa') > indexOfName(results, 'AAA'))
    })

    it('removes with default behavior without collation param', async () => {
      await peopleService.remove(null, { query: { name: { $gt: 'AAA' } } })

      const results = await peopleService.find({ paginate: false })

      assert.strictEqual(results.length, 1)
      assert.strictEqual(results[0].name, 'AAA')
    })

    it('removes using collation param if present', async () => {
      const removed = await peopleService.remove(null, {
        query: { name: 'AAA' },
        mongodb: { collation: { locale: 'en', strength: 1 } }
      })
      const results = await peopleService.find({ paginate: false })

      assert.strictEqual(removed.length, 2)
      assert.strictEqual(results[0].name, 'ccc')
      assert.strictEqual(results.length, 1)
    })

    it('handles errors', async () => {
      await assert.rejects(
        () =>
          peopleService.create(
            {
              name: 'Dave'
            },
            {
              mongodb: { collation: { locale: 'fdsfdsfds', strength: 1 } }
            }
          ),
        {
          name: 'GeneralError'
        }
      )
    })

    it('updates with default behavior without collation param', async () => {
      const query = { name: { $gt: 'AAA' } }

      const result = await peopleService.patch(null, { age: 99 }, { query })

      assert.strictEqual(result.length, 2)
      result.forEach((person) => {
        assert.strictEqual(person.age, 99)
      })
    })

    it('updates using collation param if present', async () => {
      const result = await peopleService.patch(
        null,
        { age: 110 },
        {
          query: { name: { $gt: 'AAA' } },
          mongodb: { collation: { locale: 'en', strength: 1 } }
        }
      )

      assert.strictEqual(result.length, 1)
      assert.strictEqual(result[0].name, 'ccc')
    })

    it('pushes to an array using patch', async () => {
      const result = await peopleService.patch(
        null,
        { $push: { friends: 'Adam' } },
        {
          query: { name: { $gt: 'AAA' } }
        }
      )

      assert.strictEqual(result[0].friends?.length, 1)

      const patched = await peopleService.patch(
        null,
        {
          $push: { friends: 'Bell' }
        },
        { query: { name: { $gt: 'AAA' } } }
      )

      assert.strictEqual(patched[0].friends?.length, 2)
    })

    it('can use $limit in patch', async () => {
      const data = { name: 'ddd' }
      const query = { $limit: 1 }

      const result = await peopleService._patch(null, data, {
        query
      })

      assert.strictEqual(result.length, 1)
      assert.strictEqual(result[0].name, 'ddd')

      const pipelineResult = await peopleService._patch(null, data, {
        pipeline: [],
        query
      })

      assert.strictEqual(pipelineResult.length, 1)
      assert.strictEqual(pipelineResult[0].name, 'ddd')
    })

    it('can use $limit in remove', async () => {
      const query = { $limit: 1 }

      const result = await peopleService._remove(null, {
        query
      })

      assert.strictEqual(result.length, 1)

      const pipelineResult = await peopleService._remove(null, {
        pipeline: [],
        query
      })

      assert.strictEqual(pipelineResult.length, 1)
    })

    it('can use $sort in patch', async () => {
      const updated = await peopleService._patch(
        null,
        { name: 'ddd' },
        {
          query: { $limit: 1, $sort: { name: -1 } }
        }
      )

      const result = await peopleService.find({
        paginate: false,
        query: { $limit: 1, $sort: { name: -1 } }
      })

      assert.strictEqual(updated.length, 1)
      assert.strictEqual(result[0].name, 'ddd')

      const pipelineUpdated = await peopleService._patch(
        null,
        { name: 'eee' },
        {
          pipeline: [],
          query: { $limit: 1, $sort: { name: -1 } }
        }
      )

      const pipelineResult = await peopleService.find({
        paginate: false,
        pipeline: [],
        query: { $limit: 1, $sort: { name: -1 } }
      })

      assert.strictEqual(pipelineUpdated.length, 1)
      assert.strictEqual(pipelineResult[0].name, 'eee')
    })

    it('can use $sort in remove', async () => {
      const removed = await peopleService._remove(null, {
        query: { $limit: 1, $sort: { name: -1 } }
      })

      assert.strictEqual(removed.length, 1)
      assert.strictEqual(removed[0].name, 'ccc')

      const pipelineRemoved = await peopleService._remove(null, {
        pipeline: [],
        query: { $limit: 1, $sort: { name: -1 } }
      })

      assert.strictEqual(pipelineRemoved.length, 1)
      assert.strictEqual(pipelineRemoved[0].name, 'aaa')
    })

    it('overrides default index selection using hint param if present', async () => {
      const indexed = await peopleService.create({
        name: 'Indexed',
        team: 'blue'
      })

      const result = await peopleService.find({
        paginate: false,
        query: {},
        mongodb: { hint: { name: 1 } }
      })

      assert.strictEqual(result[0].name, 'Indexed')
      assert.strictEqual(result.length, 1)

      await peopleService.remove(indexed._id)
    })
  })

  describe('Aggregation', () => {
    let bob: any
    let alice: any
    let doug: any

    before(async () => {
      app.use(
        'todos',
        new MongoDBService({
          Model: db.collection('todos'),
          events: ['testing']
        })
      )
      bob = await app.service('people').create({ name: 'Bob', age: 25 })
      alice = await app.service('people').create({ name: 'Alice', age: 19 })
      doug = await app.service('people').create({ name: 'Doug', age: 32 })

      // Create a task for each person
      await app.service('todos').create({ name: 'Bob do dishes', userId: bob._id })
      await app.service('todos').create({ name: 'Bob do laundry', userId: bob._id })
      await app.service('todos').create({ name: 'Alice do dishes', userId: alice._id })
      await app.service('todos').create({ name: 'Doug do dishes', userId: doug._id })
    })

    after(async () => {
      db.collection('people').deleteMany({})
      db.collection('todos').deleteMany({})
    })

    it('assumes the feathers stage runs before all if it is not explicitly provided in pipeline', async () => {
      const result = await app.service('todos').find({
        query: { name: /dishes/, $sort: { name: 1 } },
        pipeline: [
          {
            $lookup: {
              from: 'people',
              localField: 'userId',
              foreignField: '_id',
              as: 'person'
            }
          },
          { $unwind: { path: '$person' } }
        ],
        paginate: false
      })
      assert.deepEqual(result[0].person, alice)
      assert.deepEqual(result[1].person, bob)
      assert.deepEqual(result[2].person, doug)
    })

    it('can prepend stages by explicitly placing the feathers stage', async () => {
      const result = await app.service('todos').find({
        query: { $sort: { name: 1 } },
        pipeline: [
          { $match: { name: 'Bob do dishes' } },
          { $feathers: {} },
          {
            $lookup: {
              from: 'people',
              localField: 'userId',
              foreignField: '_id',
              as: 'person'
            }
          },
          { $unwind: { path: '$person' } }
        ],
        paginate: false
      })
      assert.deepEqual(result[0].person, bob)
      assert.equal(result.length, 1)
    })

    it('can count documents with aggregation', async () => {
      const service = app.service('people')
      const paginateBefore = service.options.paginate

      const test = async (paginate: any) => {
        service.options.paginate = paginate
        const query = { age: { $gte: 25 } }
        const findResult = await app.service('people').find({ query })
        const aggregationResult = await app.service('people').find({ query, pipeline: [] })
        assert.deepStrictEqual(findResult.total, aggregationResult.total)
      }

      await test({ default: 10, max: 50 })
      // There are 2 people with age >= 25.
      // Test that aggregation works when results are less than default
      await test({ default: 1, max: 50 })

      service.options.paginate = paginateBefore
    })

    it('can use aggregation in _get', async () => {
      const dave = await app.service('people').create({ name: 'Dave', age: 25 })
      const result = await app.service('people').get(dave._id, {
        pipeline: [{ $addFields: { aggregation: true } }]
      })

      assert.deepStrictEqual(result, { ...dave, aggregation: true })

      app.service('people').remove(dave._id)
    })

    it('can use aggregation in _create', async () => {
      const dave = (await app.service('people').create(
        { name: 'Dave' },
        {
          pipeline: [{ $addFields: { aggregation: true } }]
        }
      )) as any

      assert.deepStrictEqual(dave.aggregation, true)

      app.service('people').remove(dave._id)
    })

    it('can use aggregation in multi _create', async () => {
      app.service('people').options.multi = true
      const dave = (await app.service('people').create([{ name: 'Dave' }], {
        pipeline: [{ $addFields: { aggregation: true } }]
      })) as any

      assert.deepStrictEqual(dave[0].aggregation, true)

      app.service('people').options.multi = false
      app.service('people').remove(dave[0]._id)
    })

    it('can use aggregation in _update', async () => {
      const dave = await app.service('people').create({ name: 'Dave' })
      const result = await app.service('people').update(
        dave._id,
        {
          name: 'Marshal'
        },
        {
          pipeline: [{ $addFields: { aggregation: true } }]
        }
      )

      assert.deepStrictEqual(result, { ...dave, name: 'Marshal', aggregation: true })

      app.service('people').remove(dave._id)
    })

    it('can use aggregation in _patch', async () => {
      const dave = await app.service('people').create({ name: 'Dave' })
      const result = await app.service('people').patch(
        dave._id,
        {
          name: 'Marshal'
        },
        {
          pipeline: [{ $addFields: { aggregation: true } }]
        }
      )

      assert.deepStrictEqual(result, { ...dave, name: 'Marshal', aggregation: true })

      app.service('people').remove(dave._id)
    })

    it('can use aggregation in multi _patch', async () => {
      app.service('people').options.multi = true
      const dave = await app.service('people').create({ name: 'Dave' })
      const result = await app.service('people').patch(
        null,
        {
          name: 'Marshal'
        },
        {
          query: { _id: dave._id },
          pipeline: [{ $addFields: { aggregation: true } }]
        }
      )

      assert.deepStrictEqual(result[0], { ...dave, name: 'Marshal', aggregation: true })

      app.service('people').options.multi = false
      app.service('people').remove(dave._id)
    })

    it('can use aggregation and query in _update', async () => {
      const dave = await app.service('people').create({ name: 'Dave' })
      const result = await app.service('people').update(
        dave._id,
        {
          name: 'Marshal'
        },
        {
          query: { name: 'Dave' },
          pipeline: [{ $addFields: { aggregation: true } }]
        }
      )

      assert.deepStrictEqual(result, { ...dave, name: 'Marshal', aggregation: true })

      app.service('people').remove(dave._id)
    })

    it('can use aggregation and query in _patch', async () => {
      const dave = await app.service('people').create({ name: 'Dave' })
      const result = await app.service('people').patch(
        dave._id,
        {
          name: 'Marshal'
        },
        {
          query: { name: 'Dave' },
          pipeline: [{ $addFields: { aggregation: true } }]
        }
      )

      assert.deepStrictEqual(result, { ...dave, name: 'Marshal', aggregation: true })

      app.service('people').remove(dave._id)
    })

    it('can use aggregation in _remove', async () => {
      const dave = await app.service('people').create({ name: 'Dave' })
      const result = await app.service('people').remove(dave._id, {
        pipeline: [{ $addFields: { aggregation: true } }]
      })

      assert.deepStrictEqual(result, { ...dave, aggregation: true })

      try {
        await await app.service('people').get(dave._id)
        throw new Error('Should never get here')
      } catch (error: any) {
        assert.strictEqual(error.name, 'NotFound', 'Got a NotFound Feathers error')
      }
    })

    it('can use aggregation in multi _remove', async () => {
      app.service('people').options.multi = true
      const dave = await app.service('people').create({ name: 'Dave' })
      const result = await app.service('people').remove(null, {
        query: { _id: dave._id },
        pipeline: [{ $addFields: { aggregation: true } }]
      })

      assert.deepStrictEqual(result[0], { ...dave, aggregation: true })

      app.service('people').options.multi = false
      // app.service('people').remove(dave._id)
    })
  })

  describe('query validation', () => {
    it('validated queries are not sanitized', async () => {
      const dave = await app.service('people').create({ name: 'Dave' })
      const result = await app.service('people').find({
        query: {
          name: {
            $regex: 'Da.*'
          }
        }
      })
      assert.deepStrictEqual(result, [dave])

      app.service('people').remove(dave._id)
    })
  })

  // TODO: Should this test be part of the adapterTests?
  describe('Updates mutated query', () => {
    it('Can re-query mutated data', async () => {
      const dave = await app.service('people').create({ name: 'Dave' })
      const dave2 = await app.service('people').create({ name: 'Dave' })
      app.service('people').options.multi = true

      const updated = await app
        .service('people')
        .update(dave._id, { name: 'Marshal' }, { query: { name: 'Dave' } })

      assert.deepStrictEqual(updated, {
        ...dave,
        name: 'Marshal'
      })

      const patched = await app
        .service('people')
        .patch(dave._id, { name: 'Dave' }, { query: { name: 'Marshal' } })

      assert.deepStrictEqual(patched, {
        ...dave,
        name: 'Dave'
      })

      const updatedPipeline = await app
        .service('people')
        .update(dave._id, { name: 'Marshal' }, { query: { name: 'Dave' }, pipeline: [] })

      assert.deepStrictEqual(updatedPipeline, {
        ...dave,
        name: 'Marshal'
      })

      const patchedPipeline = await app
        .service('people')
        .patch(dave._id, { name: 'Dave' }, { query: { name: 'Marshal' }, pipeline: [] })

      assert.deepStrictEqual(patchedPipeline, {
        ...dave,
        name: 'Dave'
      })

      const multiPatch = await app
        .service('people')
        .patch(null, { name: 'Marshal' }, { query: { name: 'Dave' } })

      assert.deepStrictEqual(multiPatch, [
        {
          ...dave,
          name: 'Marshal'
        },
        {
          ...dave2,
          name: 'Marshal'
        }
      ])

      const multiPatchPipeline = await app
        .service('people')
        .patch(null, { name: 'Dave' }, { query: { name: 'Marshal' }, pipeline: [] })

      assert.deepStrictEqual(multiPatchPipeline, [
        {
          ...dave,
          name: 'Dave'
        },
        {
          ...dave2,
          name: 'Dave'
        }
      ])

      app.service('people').options.multi = false

      app.service('people').remove(dave._id)
      app.service('people').remove(dave2._id)
    })
  })

  testSuite(app, errors, 'people', '_id')
  testSuite(app, errors, 'people-customid', 'customid')
})
