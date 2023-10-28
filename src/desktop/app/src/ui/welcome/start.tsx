import * as React from 'react'
import { WelcomeStep } from './welcome'
import { LinkButton } from '../lib/link-button'
import { Dispatcher } from '../dispatcher'
import { Octicon } from '../octicons'
import * as OcticonSymbol from '../octicons/octicons.generated'
import { Button } from '../lib/button'
import { Loading } from '../lib/loading'
import { BrowserRedirectMessage } from '../lib/authentication-form'
import { SamplesURL } from '../../lib/stats'

/**
 * The URL to the sign-up page on GitHub.com. Used in conjunction
 * with account actions in the app where the user might want to
 * consider signing up.
 */
export const CreateAccountURL = 'https://github.com/join?source=github-desktop'

interface IStartProps {
  readonly advance: (step: WelcomeStep) => void
  readonly done: () => void
  readonly dispatcher: Dispatcher
  readonly loadingBrowserAuth: boolean
}

/** The first step of the Welcome flow. */
export class Start extends React.Component<IStartProps, {}> {
  public render() {
    return (
      <section
        id="start"
        aria-label="Welcome to Checkpoint"
        aria-describedby="start-description"
      >
        <h1 className="welcome-title">Welcome to Checkpoint</h1>
        {!this.props.loadingBrowserAuth ? (
          <>
            <p id="start-description" className="welcome-text">
              Checkpoint is an end-to-end software development platform,
              including version control, issue tracking, and pull request
              reviews. Checkpoint is designed by game developers for game
              developers. Sign in below to get started with your new or existing
              projects.
            </p>
          </>
        ) : (
          <p>{BrowserRedirectMessage}</p>
        )}

        <div className="welcome-main-buttons">
          <Button
            type="submit"
            className="button-with-icon"
            disabled={this.props.loadingBrowserAuth}
            onClick={this.signInWithBrowser}
            autoFocus={true}
          >
            {this.props.loadingBrowserAuth && <Loading />}
            Sign in to CheckpointVCS.com
            <Octicon symbol={OcticonSymbol.linkExternal} />
          </Button>
          {this.props.loadingBrowserAuth ? (
            <Button onClick={this.cancelBrowserAuth}>Cancel</Button>
          ) : (
            <Button onClick={this.signInToCustom}>
              Sign in to a custom server
            </Button>
          )}
        </div>
        <div className="skip-action-container">
          <p className="welcome-text">
            New to Checkpoint?{' '}
            <LinkButton uri={CreateAccountURL} className="create-account-link">
              Create your free account.
            </LinkButton>
          </p>
        </div>
        <div className="welcome-start-disclaimer-container">
          By creating an account, you agree to the{' '}
          <LinkButton uri={'https://github.com/site/terms'}>
            Terms of Service
          </LinkButton>
          . For more information about GitHub's privacy practices, see the{' '}
          <LinkButton uri={'https://github.com/site/privacy'}>
            GitHub Privacy Statement
          </LinkButton>
          .<br />
          <br />
          GitHub Desktop sends usage metrics to improve the product and inform
          feature decisions.{' '}
          <LinkButton uri={SamplesURL}>
            Learn more about user metrics.
          </LinkButton>
        </div>
      </section>
    )
  }

  private signInWithBrowser = (event?: React.MouseEvent<HTMLButtonElement>) => {
    if (event) {
      event.preventDefault()
    }

    // TODO MIKE HERE: figure out auth
    // this.props.advance(WelcomeStep.SignInToOfficialWithBrowser)
    // this.props.dispatcher.requestBrowserAuthenticationToOfficial()
    this.props.done()
  }

  private cancelBrowserAuth = () => {
    this.props.advance(WelcomeStep.Start)
  }

  private signInToCustom = () => {
    this.props.advance(WelcomeStep.SignInToCustom)
  }
}
