/* eslint-disable react/no-unused-state */
import React, {Component, createContext} from 'react';
import PropTypes from 'prop-types';
import {AuthClass} from '@aws-amplify/auth';
import {
  configure,
  resetState,
  shouldEnforceRoute,
} from './helpers/functions';
import {defaultState, defaultProps} from './helpers/defaults';
import {emitEvent, setDebugging} from './helpers/debug';

let Auth;
let AuthRefreshTimer;

const Context = createContext({state: defaultState()});

const {Provider, Consumer} = Context;

class IdentityProvider extends Component {
  static propTypes = {
    DEBUG: PropTypes.bool,
    awsAuthConfig: PropTypes.any,
    routingConfig: PropTypes.any,
    location: PropTypes.object.isRequired,
    history: PropTypes.object.isRequired,
    children: PropTypes.any,
    refreshInterval: PropTypes.number
  };

  static defaultProps = defaultProps;

  state = defaultState();

  constructor(props) {
    super(props);
    const {DEBUG: DebugMode} = props;
    setDebugging(DebugMode);
    this.resetState = resetState.bind(this);
    this.maybeForceLoginPage = this.maybeForceLoginPage.bind(this);
    this.onAuthenticationResponse = this.onAuthenticationResponse.bind(this);
    this.challengeResponseCallback = this.challengeResponseCallback.bind(this);
    this.signIn = this.signIn.bind(this);
    this.navigateOnSuccess = this.navigateOnSuccess.bind(this);
    this.navigateToLogin = this.navigateToLogin.bind(this);
    this.signOut = this.signOut.bind(this);
    this.onRouteUpdate = this.onRouteUpdate.bind(this);
    this.obtainAWSCredentials = this.obtainAWSCredentials.bind(this);
    this.maybeRestoreSession = this.maybeRestoreSession.bind(this);
    this.forgotPassword = this.forgotPassword.bind(this);
    this.resetPassword = this.resetPassword.bind(this);
    this.reset = this.reset.bind(this);
    this.stopTimer = this.stopTimer.bind(this);
    this.maybeStartTimer = this.maybeStartTimer.bind(this);
  }

  componentDidMount() {
    const {
      awsAuthConfig,
      routingConfig,
      location,
      history,
    } = this.props;
    history.listen(this.onRouteUpdate.bind(this));
    const {username, config} = configure(awsAuthConfig);
    if (username) {
      emitEvent.call(this, null, 'Provided default username', username);
    }
    emitEvent.call(this, null, `${routingConfig ? 'has' : 'does not have'} routing configuration`);

    this.reset(() => {
      if (process.env.NODE_ENV !== 'offline') {
        Auth = new AuthClass(config);
        Auth.currentAuthenticatedUser()
          .then((user) => {
            const shouldDestroyPreviousSession = username !== null
              && username !== undefined
              && user.getUsername() !== username;
            if (shouldDestroyPreviousSession) {
              emitEvent.call(this, null, 'Removing previous session for', user.getUsername());
              Auth.signOut({global: false})
                .then(() => this.maybeRestoreSession({
                  redirect: shouldEnforceRoute(location.pathname, routingConfig),
                }))
                .catch((error) => emitEvent.call(this, error));
            } else {
              emitEvent.call(this, undefined, 'restoring session');
              this.maybeRestoreSession({redirect: shouldEnforceRoute(location.pathname, routingConfig)});
            }
          })
          .catch(() => {
            this.maybeRestoreSession({redirect: shouldEnforceRoute(location.pathname, routingConfig)});
          });
      }
    });
  }

  challengeResponseCallback = (user) => ({answer, newPassword = null}) => {
    // Responding to custom auth challenges
    if (user.authenticationFlowType === 'CUSTOM_AUTH') {
      Auth.sendCustomChallengeAnswer(user, answer)
        .then((success) => {
          emitEvent.call(this, null, 'Succeeded', success);
          return this.onAuthenticationResponse(user);
        })
        .catch(error => emitEvent.call(this, error));
    } else if (user.challengeName === 'NEW_PASSWORD_REQUIRED') {
      // If user needs to set a new password
      emitEvent.call(this, null, 'Submitting new password...');
      Auth.completeNewPassword(
        user, // the Cognito User Object
        newPassword, // the new password
        {}
      )
        .then((success) => {
          emitEvent.call(this, null, 'Succeeded', success);
          return this.onAuthenticationResponse(user);
        })
        .catch((error) => emitEvent.call(this, error));
    }
  };

  reset = (callback = () => {}) => this.resetState(callback);

  forgotPassword = ({username}) => {
    emitEvent(null, 'Initiating forgot password for', username);
    Auth.forgotPassword(username)
      .then(importantDetail => this.setState({importantDetail, authenticated: false}))
      .catch(error => emitEvent.call(this, error));
  };

  resetPassword = ({username, newPassword, code}) => {
    Auth.forgotPasswordSubmit(username, code, newPassword)
      .then(importantDetail => this.setState({importantDetail, authenticated: false}))
      .catch(error => emitEvent.call(this, error));
  };

  onAuthenticationResponse = (cognitoUser) => {
    const {awsAuthConfig} = this.props;
    const {challengeParam: challengeParameters, signInUserSession: session} = cognitoUser;
    this.setState({
      authenticated: session !== undefined && session !== null,
      session,
      challengeParameters,
      answerAuthChallenge: this.challengeResponseCallback(cognitoUser),
    });
    if (challengeParameters) {
      emitEvent.call(this, null, 'Received Auth Challenge');
    }

    // For identity pool and direct AwS Resource access
    if (session && awsAuthConfig.identityPoolId) {
      this.obtainAWSCredentials(cognitoUser, (error, data) => {
        emitEvent.call(this, error, data);
        if (!error) {
          this.setState({
            authenticated: true,
            session: data.session,
            awsCredentials: data.credentials,
          });
        }
      });
    }

    if (session) {
      this.maybeStartTimer();
      const {routingConfig} = this.props;
      if (routingConfig && routingConfig.loginSuccess) {
        this.navigateToLogin(routingConfig.loginSuccess);
      } else {
        this.navigateOnSuccess();
      }
    }
  };

  onRouteUpdate = (ev) => {
    const {routingConfig} = this.props;
    const {session} = this.state;
    emitEvent.call(this, null, ev);
    if (shouldEnforceRoute(ev.pathname, routingConfig) && !session) {
      emitEvent.call(this, null, {message: 'Should check session'});
    }
    if (!session) {
      this.maybeRestoreSession({redirect: shouldEnforceRoute(ev.pathname, routingConfig)});
    }
  };

  navigateToLogin = (path, callback) => {
    const {history, location} = this.props;
    if (!history) {
      emitEvent.call(this, new Error('Router not instantiated!'), null);
      if (callback) {
        callback(null, null);
      }
      return;
    }
    const lastPage = location.pathname;
    emitEvent.call(this, null, {lastPage, path});
    if (path === lastPage) {
      if (callback) {
        callback(null, null);
      }
      return;
    }
    this.setState({
      lastPage
    }, () => {
      history.push(path);
      if (callback) {
        callback(null, null);
      }
    });
  };

  navigateOnSuccess = () => {
    const {history} = this.props;
    const {lastPage} = this.state;
    if (!lastPage) {
      return;
    }
    if (!history) {
      emitEvent.call(this, new Error('Router not instantiated!'));
      return;
    }
    history.goBack();
  };

  obtainAWSCredentials = (user, callback = () => {}) => {
    const session = user.getSignInUserSession();
    if (!session) {
      return callback(new Error('No user'));
    }
    return Auth.currentUserCredentials()
      .then((credentials) => callback(undefined, {credentials, session}))
      .catch(callback);
  };

  maybeForceLoginPage = (redirect, Username) => {
    const {routingConfig, location} = this.props;
    if (Username) {
      emitEvent.call(this, undefined, `Attempting sign-in for ${Username}`);
    }
    if (shouldEnforceRoute(location.pathname, routingConfig)) {
      this.navigateToLogin(routingConfig.login, () => {
        emitEvent.call(this, null, 'Redirection completed');
        if (!Username) {
          this.setState({
            error: 'No User',
          });
          return;
        }
        this.signIn({username: Username});
      });
    } else if (Username) {
        this.signIn({username: Username});
      } else {
      this.setState({
        error: 'No User',
      });
    }
  };

  maybeStartTimer = () => {
    const {refreshInterval} = this.props;
    if (!AuthRefreshTimer && refreshInterval) {
      const {location, routingConfig} = this.props;
      AuthRefreshTimer = setInterval(() => {
        this.maybeRestoreSession({redirect: shouldEnforceRoute(location.pathname, routingConfig)});
      }, 60 * 1000 * refreshInterval);
    }
  };

  stopTimer = () => {
    clearInterval(AuthRefreshTimer);
  };

  maybeRestoreSession = ({redirect}) => {
    return new Promise(resolve => {
      const {awsAuthConfig} = this.props;
      let username = awsAuthConfig.username;
      Auth.currentUserPoolUser()
        .then((user) => {
          username = user.getUsername() || username;
          emitEvent.call(this, undefined, username);
          if (awsAuthConfig.identityPoolId) {
            this.obtainAWSCredentials(user, (error, data) => {
              if (!error) {
                const {session, credentials} = data;
                if (session && session.isValid()) {
                  this.setState({
                    session,
                    awsCredentials: credentials,
                    tapSession: () => this.maybeRestoreSession({redirect}),
                    authenticated: true,
                  }, () => {
                    resolve(session);
                    this.maybeStartTimer();
                  });
                } else {
                  this.stopTimer();
                  resolve(undefined);
                }
              } else {
                emitEvent.call(this, undefined, error.message);
                this.setState({
                  session: null,
                  authenticated: false,
                }, () => {
                  this.stopTimer();
                  resolve(undefined);
                  this.maybeForceLoginPage(redirect || false, username);
                });
              }
            });
          } else {
            Auth.currentSession()
              .then((session) => {
                if ((!session || !session.isValid()) && redirect) {
                  resolve(undefined);
                  this.maybeForceLoginPage(redirect, username);
                } else {
                  emitEvent.call(this, undefined, 'current session', session.isValid());
                  this.setState({
                    session,
                    authenticated: true,
                    tapSession: () => this.maybeRestoreSession({redirect}),
                  }, () => {
                    this.maybeStartTimer();
                    resolve(session);
                  });
                }
              })
              .catch((error) => {
                resolve(undefined);
                emitEvent.call(this, undefined, error.message);
              });
          }
        })
        .catch((error) => {
          emitEvent.call(this, undefined, error.message);
          this.setState({
            authenticated: false,
          }, () => {
            resolve(undefined);
            this.stopTimer();
            this.maybeForceLoginPage(redirect, username);
          });
        });
    });
  };

  signIn = ({username, password}) => {
    this.setState({
      error: null,
    }, () => {
      Auth.signIn(username, password)
        .then(this.onAuthenticationResponse)
        .catch(error => emitEvent.call(this, error));
    });
  };

  signOut = (invalidateAllSessions = false) => {
    const {routingConfig, awsAuthConfig} = this.props;
    this.stopTimer();
    Auth.currentUserPoolUser()
      .then(() => {
        Auth.signOut({global: invalidateAllSessions})
          .then(() => this.reset(() => {
              const {logout, login} = routingConfig || {login: null, logout: null};
              if ((login || logout) && !awsAuthConfig.oauth) {
                this.navigateToLogin(logout || login || '');
              }
            })
          )
          .catch(error => this.reset(() => {
            emitEvent.call(this, error);
            const {logout, login} = routingConfig || {login: null, logout: null};
            if ((login || logout) && !awsAuthConfig.oauth) {
              this.navigateToLogin(logout || login || '');
            }
          }));
      })
      .catch(e => emitEvent.call(this, e));
  };

  resetState;

  render() {
    const {children} = this.props;
    const {state} = this;
    return (
      <Provider value={{state}}>
        {children}
      </Provider>
    );
  }
}

export {IdentityProvider as default, Consumer};
/* eslint-enable react/no-unused-state */
