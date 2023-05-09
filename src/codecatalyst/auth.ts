/*!
 * Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { CodeCatalystClient, createClient } from '../shared/clients/codecatalystClient'
import { getIdeProperties } from '../shared/extensionUtilities'
import {
    Auth,
    isBuilderIdConnection,
    Connection,
    SsoConnection,
    codecatalystScopes,
    hasScopes,
    createBuilderIdConnection,
    ssoAccountAccessScopes,
} from '../credentials/auth'
import { getSecondaryAuth } from '../credentials/secondaryAuth'
import { getLogger } from '../shared/logger'
import * as localizedText from '../shared/localizedText'
import { ToolkitError, isAwsError } from '../shared/errors'
import { MetricName, MetricShapes, telemetry } from '../shared/telemetry/telemetry'
import { openUrl } from '../shared/utilities/vsCodeUtils'

// Secrets stored on the macOS keychain appear as individual entries for each key
// This is fine so long as the user has only a few accounts. Otherwise this should
// store secrets as a map.
export class CodeCatalystAuthStorage {
    public constructor(private readonly secrets: vscode.SecretStorage) {}

    public async getPat(username: string): Promise<string | undefined> {
        return this.secrets.get(`codecatalyst.pat.${username}`)
    }

    public async storePat(username: string, pat: string): Promise<void> {
        await this.secrets.store(`codecatalyst.pat.${username}`, pat)
    }
}

export const onboardingUrl = vscode.Uri.parse('https://codecatalyst.aws/onboarding/view')

const defaultScopes = [...ssoAccountAccessScopes, ...codecatalystScopes]
export const isValidCodeCatalystConnection = (conn: Connection): conn is SsoConnection =>
    isBuilderIdConnection(conn) && hasScopes(conn, codecatalystScopes)

export const isUpgradeableConnection = (conn: Connection): conn is SsoConnection =>
    isBuilderIdConnection(conn) && !isValidCodeCatalystConnection(conn)

export class CodeCatalystAuthenticationProvider {
    public readonly onDidChangeActiveConnection = this.secondaryAuth.onDidChangeActiveConnection

    public constructor(
        protected readonly storage: CodeCatalystAuthStorage,
        protected readonly memento: vscode.Memento,
        public readonly auth = Auth.instance,
        public readonly secondaryAuth = getSecondaryAuth(
            auth,
            'codecatalyst',
            'CodeCatalyst',
            isValidCodeCatalystConnection
        )
    ) {}

    public get activeConnection() {
        return this.secondaryAuth.activeConnection
    }

    public get isUsingSavedConnection() {
        return this.secondaryAuth.isUsingSavedConnection
    }

    // Get rid of this? Not sure where to put PAT code.
    public async getPat(client: CodeCatalystClient, username = client.identity.name): Promise<string> {
        const stored = await this.storage.getPat(username)

        if (stored) {
            return stored
        }

        const resp = await client.createAccessToken({ name: 'aws-toolkits-vscode-token' })
        await this.storage.storePat(username, resp.secret)

        return resp.secret
    }

    public async getCredentialsForGit(client: CodeCatalystClient) {
        getLogger().verbose(`codecatalyst (git): attempting to provide credentials`)

        const username = client.identity.name

        try {
            return {
                username,
                password: await this.getPat(client, username),
            }
        } catch (err) {
            getLogger().verbose(`codecatalyst (git): failed to get credentials for user "${username}": %s`, err)
        }
    }

    public async removeSavedConnection() {
        await this.secondaryAuth.removeConnection()
    }

    public async restore() {
        await this.secondaryAuth.restoreConnection()
    }

    public async promptOnboarding(): Promise<void> {
        const message = `Using CodeCatalyst requires onboarding with a Space. Sign up with CodeCatalyst to get started.`
        const openBrowser = 'Open Browser'
        const resp = await vscode.window.showInformationMessage(message, { modal: true }, openBrowser)
        if (resp === openBrowser) {
            await openUrl(onboardingUrl)
        }

        // Mark the current execution as cancelled regardless of the user response. We could poll here instead, waiting
        // for the user to onboard. But that might take a while.
        throw new ToolkitError('Not onboarded with CodeCatalyst', { code: 'NotOnboarded', cancelled: true })
    }

    public async promptNotConnected(): Promise<SsoConnection> {
        type ConnectionFlowEvent = Partial<MetricShapes[MetricName]> & {
            readonly codecatalyst_connectionFlow: 'Create' | 'Switch' | 'Upgrade' // eslint-disable-line @typescript-eslint/naming-convention
        }

        const conn = (await this.auth.listConnections()).find(isBuilderIdConnection)
        const continueItem: vscode.MessageItem = { title: localizedText.continueText }
        const cancelItem: vscode.MessageItem = { title: localizedText.cancel, isCloseAffordance: true }

        if (conn === undefined) {
            telemetry.record({
                codecatalyst_connectionFlow: 'Create',
            } satisfies ConnectionFlowEvent as MetricShapes[MetricName])

            const message = `The ${
                getIdeProperties().company
            } Toolkit extension requires a connection for CodeCatalyst to begin.\n\n Proceed to the browser to allow access?`

            const resp = await vscode.window.showInformationMessage(message, { modal: true }, continueItem, cancelItem)
            if (resp !== continueItem) {
                throw new ToolkitError('Not connected to CodeCatalyst', { code: 'NoConnection', cancelled: true })
            }

            const newConn = await createBuilderIdConnection(this.auth, defaultScopes)
            if (this.auth.activeConnection?.id !== newConn.id) {
                await this.secondaryAuth.useNewConnection(newConn)
            }

            return newConn
        }

        const upgrade = async () => {
            telemetry.record({
                codecatalyst_connectionFlow: 'Upgrade',
            } satisfies ConnectionFlowEvent as MetricShapes[MetricName])

            return this.secondaryAuth.addScopes(conn, defaultScopes)
        }

        if (isBuilderIdConnection(conn) && this.auth.activeConnection?.id !== conn.id) {
            telemetry.record({
                codecatalyst_connectionFlow: 'Switch',
            } satisfies ConnectionFlowEvent as MetricShapes[MetricName])

            const resp = await vscode.window.showInformationMessage(
                'CodeCatalyst requires an AWS Builder ID connection.\n\n Switch to it now?',
                { modal: true },
                continueItem,
                cancelItem
            )
            if (resp !== continueItem) {
                throw new ToolkitError('Not connected to CodeCatalyst', { code: 'NoConnection', cancelled: true })
            }

            if (isUpgradeableConnection(conn)) {
                await upgrade()
            }

            await this.secondaryAuth.useNewConnection(conn)

            return conn
        }

        if (isUpgradeableConnection(conn)) {
            return upgrade()
        }

        throw new ToolkitError('Not connected to CodeCatalyst', { code: 'NoConnectionBadState' })
    }

    public async isConnectionOnboarded(conn: SsoConnection, recheck = false) {
        const mementoKey = 'codecatalyst.connections'
        const getState = () => this.memento.get(mementoKey, {} as Record<string, { onboarded: boolean }>)
        const updateState = (state: { onboarded: boolean }) =>
            this.memento.update(mementoKey, {
                ...getState(),
                [conn.id]: state,
            })

        const state = getState()[conn.id]
        if (state !== undefined && !recheck) {
            return state.onboarded
        }

        try {
            await createClient(conn)
            await updateState({ onboarded: true })

            return true
        } catch (e) {
            if (isOnboardingException(e) && this.auth.getConnectionState(conn) === 'valid') {
                await updateState({ onboarded: false })

                return false
            }

            throw e
        }

        function isOnboardingException(e: unknown) {
            // `GetUserDetails` returns `AccessDeniedException` if the user has not onboarded
            return isAwsError(e) && e.code === 'AccessDeniedException' && e.message.includes('GetUserDetails')
        }
    }

    private static instance: CodeCatalystAuthenticationProvider

    public static fromContext(ctx: Pick<vscode.ExtensionContext, 'secrets' | 'globalState'>) {
        return (this.instance ??= new this(new CodeCatalystAuthStorage(ctx.secrets), ctx.globalState))
    }
}
