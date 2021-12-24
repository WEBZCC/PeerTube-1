import { createClient } from 'redis'
import { exists } from '@server/helpers/custom-validators/misc'
import { logger } from '../helpers/logger'
import { generateRandomString } from '../helpers/utils'
import { CONFIG } from '../initializers/config'
import {
  CONTACT_FORM_LIFETIME,
  RESUMABLE_UPLOAD_SESSION_LIFETIME,
  TRACKER_RATE_LIMITS,
  USER_EMAIL_VERIFY_LIFETIME,
  USER_PASSWORD_CREATE_LIFETIME,
  USER_PASSWORD_RESET_LIFETIME,
  VIEW_LIFETIME,
  WEBSERVER
} from '../initializers/constants'

// Only used for typings
const redisClientWrapperForType = () => createClient<{}>()

class Redis {

  private static instance: Redis
  private initialized = false
  private connected = false
  private client: ReturnType<typeof redisClientWrapperForType>
  private prefix: string

  private constructor () {
  }

  init () {
    // Already initialized
    if (this.initialized === true) return
    this.initialized = true

    this.client = createClient(Redis.getRedisClientOptions())

    this.client.connect()
      .then(() => { this.connected = true })
      .catch(err => {
        logger.error('Cannot connect to redis', { err })
        process.exit(-1)
      })

    this.client.on('error', err => {
      logger.error('Error in Redis client.', { err })
      process.exit(-1)
    })

    this.prefix = 'redis-' + WEBSERVER.HOST + '-'
  }

  static getRedisClientOptions () {
    return Object.assign({},
      CONFIG.REDIS.AUTH ? { password: CONFIG.REDIS.AUTH } : {},
      (CONFIG.REDIS.DB) ? { db: CONFIG.REDIS.DB } : {},
      (CONFIG.REDIS.HOSTNAME && CONFIG.REDIS.PORT)
        ? { host: CONFIG.REDIS.HOSTNAME, port: CONFIG.REDIS.PORT }
        : { path: CONFIG.REDIS.SOCKET }
    )
  }

  getClient () {
    return this.client
  }

  getPrefix () {
    return this.prefix
  }

  isConnected () {
    return this.connected
  }

  /* ************ Forgot password ************ */

  async setResetPasswordVerificationString (userId: number) {
    const generatedString = await generateRandomString(32)

    await this.setValue(this.generateResetPasswordKey(userId), generatedString, USER_PASSWORD_RESET_LIFETIME)

    return generatedString
  }

  async setCreatePasswordVerificationString (userId: number) {
    const generatedString = await generateRandomString(32)

    await this.setValue(this.generateResetPasswordKey(userId), generatedString, USER_PASSWORD_CREATE_LIFETIME)

    return generatedString
  }

  async removePasswordVerificationString (userId: number) {
    return this.removeValue(this.generateResetPasswordKey(userId))
  }

  async getResetPasswordLink (userId: number) {
    return this.getValue(this.generateResetPasswordKey(userId))
  }

  /* ************ Email verification ************ */

  async setVerifyEmailVerificationString (userId: number) {
    const generatedString = await generateRandomString(32)

    await this.setValue(this.generateVerifyEmailKey(userId), generatedString, USER_EMAIL_VERIFY_LIFETIME)

    return generatedString
  }

  async getVerifyEmailLink (userId: number) {
    return this.getValue(this.generateVerifyEmailKey(userId))
  }

  /* ************ Contact form per IP ************ */

  async setContactFormIp (ip: string) {
    return this.setValue(this.generateContactFormKey(ip), '1', CONTACT_FORM_LIFETIME)
  }

  async doesContactFormIpExist (ip: string) {
    return this.exists(this.generateContactFormKey(ip))
  }

  /* ************ Views per IP ************ */

  setIPVideoView (ip: string, videoUUID: string) {
    return this.setValue(this.generateIPViewKey(ip, videoUUID), '1', VIEW_LIFETIME.VIEW)
  }

  setIPVideoViewer (ip: string, videoUUID: string) {
    return this.setValue(this.generateIPViewerKey(ip, videoUUID), '1', VIEW_LIFETIME.VIEWER)
  }

  async doesVideoIPViewExist (ip: string, videoUUID: string) {
    return this.exists(this.generateIPViewKey(ip, videoUUID))
  }

  async doesVideoIPViewerExist (ip: string, videoUUID: string) {
    return this.exists(this.generateIPViewerKey(ip, videoUUID))
  }

  /* ************ Tracker IP block ************ */

  setTrackerBlockIP (ip: string) {
    return this.setValue(this.generateTrackerBlockIPKey(ip), '1', TRACKER_RATE_LIMITS.BLOCK_IP_LIFETIME)
  }

  async doesTrackerBlockIPExist (ip: string) {
    return this.exists(this.generateTrackerBlockIPKey(ip))
  }

  /* ************ Video views stats ************ */

  addVideoViewStats (videoId: number) {
    const { videoKey, setKey } = this.generateVideoViewStatsKeys({ videoId })

    return Promise.all([
      this.addToSet(setKey, videoId.toString()),
      this.increment(videoKey)
    ])
  }

  async getVideoViewsStats (videoId: number, hour: number) {
    const { videoKey } = this.generateVideoViewStatsKeys({ videoId, hour })

    const valueString = await this.getValue(videoKey)
    const valueInt = parseInt(valueString, 10)

    if (isNaN(valueInt)) {
      logger.error('Cannot get videos views stats of video %d in hour %d: views number is NaN (%s).', videoId, hour, valueString)
      return undefined
    }

    return valueInt
  }

  async listVideosViewedForStats (hour: number) {
    const { setKey } = this.generateVideoViewStatsKeys({ hour })

    const stringIds = await this.getSet(setKey)
    return stringIds.map(s => parseInt(s, 10))
  }

  deleteVideoViewsStats (videoId: number, hour: number) {
    const { setKey, videoKey } = this.generateVideoViewStatsKeys({ videoId, hour })

    return Promise.all([
      this.deleteFromSet(setKey, videoId.toString()),
      this.deleteKey(videoKey)
    ])
  }

  /* ************ Local video views buffer ************ */

  addLocalVideoView (videoId: number) {
    const { videoKey, setKey } = this.generateLocalVideoViewsKeys(videoId)

    return Promise.all([
      this.addToSet(setKey, videoId.toString()),
      this.increment(videoKey)
    ])
  }

  async getLocalVideoViews (videoId: number) {
    const { videoKey } = this.generateLocalVideoViewsKeys(videoId)

    const valueString = await this.getValue(videoKey)
    const valueInt = parseInt(valueString, 10)

    if (isNaN(valueInt)) {
      logger.error('Cannot get videos views of video %d: views number is NaN (%s).', videoId, valueString)
      return undefined
    }

    return valueInt
  }

  async listLocalVideosViewed () {
    const { setKey } = this.generateLocalVideoViewsKeys()

    const stringIds = await this.getSet(setKey)
    return stringIds.map(s => parseInt(s, 10))
  }

  deleteLocalVideoViews (videoId: number) {
    const { setKey, videoKey } = this.generateLocalVideoViewsKeys(videoId)

    return Promise.all([
      this.deleteFromSet(setKey, videoId.toString()),
      this.deleteKey(videoKey)
    ])
  }

  /* ************ Resumable uploads final responses ************ */

  setUploadSession (uploadId: string, response?: { video: { id: number, shortUUID: string, uuid: string } }) {
    return this.setValue(
      'resumable-upload-' + uploadId,
      response
        ? JSON.stringify(response)
        : '',
      RESUMABLE_UPLOAD_SESSION_LIFETIME
    )
  }

  doesUploadSessionExist (uploadId: string) {
    return this.exists('resumable-upload-' + uploadId)
  }

  async getUploadSession (uploadId: string) {
    const value = await this.getValue('resumable-upload-' + uploadId)

    return value
      ? JSON.parse(value)
      : ''
  }

  deleteUploadSession (uploadId: string) {
    return this.deleteKey('resumable-upload-' + uploadId)
  }

  /* ************ Keys generation ************ */

  private generateLocalVideoViewsKeys (videoId?: Number) {
    return { setKey: `local-video-views-buffer`, videoKey: `local-video-views-buffer-${videoId}` }
  }

  private generateVideoViewStatsKeys (options: { videoId?: number, hour?: number }) {
    const hour = exists(options.hour)
      ? options.hour
      : new Date().getHours()

    return { setKey: `videos-view-h${hour}`, videoKey: `video-view-${options.videoId}-h${hour}` }
  }

  private generateResetPasswordKey (userId: number) {
    return 'reset-password-' + userId
  }

  private generateVerifyEmailKey (userId: number) {
    return 'verify-email-' + userId
  }

  private generateIPViewKey (ip: string, videoUUID: string) {
    return `views-${videoUUID}-${ip}`
  }

  private generateIPViewerKey (ip: string, videoUUID: string) {
    return `viewer-${videoUUID}-${ip}`
  }

  private generateTrackerBlockIPKey (ip: string) {
    return `tracker-block-ip-${ip}`
  }

  private generateContactFormKey (ip: string) {
    return 'contact-form-' + ip
  }

  /* ************ Redis helpers ************ */

  private getValue (key: string) {
    return this.client.get(this.prefix + key)
  }

  private getSet (key: string) {
    return this.client.sMembers(this.prefix + key)
  }

  private addToSet (key: string, value: string) {
    return this.client.sAdd(this.prefix + key, value)
  }

  private deleteFromSet (key: string, value: string) {
    return this.client.sRem(this.prefix + key, value)
  }

  private deleteKey (key: string) {
    return this.client.del(this.prefix + key)
  }

  private async setValue (key: string, value: string, expirationMilliseconds: number) {
    const result = await this.client.set(this.prefix + key, value, { PX: expirationMilliseconds })

    if (result !== 'OK') throw new Error('Redis set result is not OK.')
  }

  private removeValue (key: string) {
    return this.client.del(this.prefix + key)
  }

  private getObject (key: string) {
    return this.client.hGetAll(this.prefix + key)
  }

  private increment (key: string) {
    return this.client.incr(this.prefix + key)
  }

  private exists (key: string) {
    return this.client.exists(this.prefix + key)
  }

  static get Instance () {
    return this.instance || (this.instance = new this())
  }
}

// ---------------------------------------------------------------------------

export {
  Redis
}
