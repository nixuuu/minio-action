const core = require('@actions/core')
const github = require('@actions/github')
const Minio = require('minio')
const glob = require('glob')
const os = require('os')
const Semaphore = require('./semafor')

;(async () => {
  try {
    // `who-to-greet` input defined in action metadata file
    const host = core.getInput('host', {
      trimWhitespace: true,
    })
    const port = core.getInput('port', {
      trimWhitespace: true,
    })
    const bucket = core.getInput('bucket', {
      trimWhitespace: true,
    })
    const accessKey = core.getInput('accessKey', {
      trimWhitespace: true,
    })
    const secretKey = core.getInput('secretKey', {
      trimWhitespace: true,
    })
    const region = core.getInput('region', {
      trimWhitespace: true,
    })
    const ssl = core.getInput('ssl', {
      trimWhitespace: true,
    })
    const paths = core.getInput('paths')
    const clearDirs = core.getInput('clearDirs')

    const minioClient = new Minio.Client({
      endPoint: host,
      port,
      useSSL: ssl === 'true',
      accessKey,
      secretKey,
      region,
    })
    if (!minioClient) {
      throw new Error('Minio client not initialized')
    }

    if (!paths) {
      throw new Error('Path is required')
    }

    if (!bucket) {
      throw new Error('Bucket is required')
    }

    const semaphore = new Semaphore(10)

    if (clearDirs) {
      const dirs = clearDirs
        .split('\n')
        .map((p) => p.trim())
        .filter((p) => p.length > 0)

      const filesToDelete = []

      for (const dir of dirs) {
        let dir2 = dir
        if (dir2.startsWith('/')) {
          dir2 = dir2.substring(1)
        }

        if (!dir2.endsWith('/') && dir2.indexOf('.') === -1) {
          dir2 = `${dir2}/`
        }

        const stream = minioClient.listObjects(bucket, dir2, true)

        await new Promise((resolve, reject) => {
          stream.on('data', (obj) => {
            filesToDelete.push(
              new Promise(async (resolve) => {
                await semaphore.acquire()
                console.log(`Deleting ${bucket}: ${obj.name}`)
                await minioClient.removeObject(bucket, obj.name, {
                  forceDelete: true,
                })
                semaphore.release()
                resolve()
              })
            )
          })
          stream.on('error', (err) => {
            reject(err)
          })
          stream.on('end', () => {
            resolve()
          })
        })
      }

      await Promise.all(filesToDelete)
      console.log(`Deleted ${filesToDelete.length} files`)
    }

    const patterns = paths
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((p) => {
        const [src, target] = p.split('=>').map((p) => p.trim())
        if (!src) {
          throw new Error(`Invalid path: ${p}`)
        }

        return { src, target }
      })

    const promises = []
    for (const { src, target } of patterns) {
      const starIndex = src.indexOf('*')
      const prefix = starIndex > -1 ? src.substring(0, starIndex) : null

      const files = glob
        .globSync(src, {
          nodir: true,
          dotRelative: false,
          absolute: false,
          platform: os.platform(),
          matchBase: false,
        })
        .map((path) => {
          path = path.replace(/\\/g, '/')
          if (path.startsWith('./')) {
            path = path.substring(2)
          } else if (path.startsWith('../')) {
            path = path.substring(3)
          }
          if (path.startsWith('/')) {
            path = path.substring(1)
          }
          return {
            target: prefix ? path.replace(prefix, '') : path,
            file: path,
          }
        })

      let target2 = target

      if (!target2) {
        target2 = `/`
      } else if (target2.startsWith('/')) {
        target2 = target2.substring(1)
      }

      if (!target2.endsWith('/') && files.length > 1) {
        target2 = `${target2}/`
      }

      for (const file of files) {
        let target3 = `${target2}${file.target}`
        promises.push(
          new Promise(async (resolve) => {
            await semaphore.acquire()
            console.log(`Uploading ${file.file} to ${bucket}: ${target3}`)
            await minioClient
              .fPutObject(bucket, target3, file.file)
              .catch((err) => {
                console.error(
                  `Error uploading ${file.file} to ${bucket}: ${target3}`,
                  err
                )
              })
            semaphore.release()
            resolve()
          })
        )
      }
    }
    await Promise.all(promises)
  } catch (error) {
    core.setFailed(error.message)
  }
})()
