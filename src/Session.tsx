import * as React from 'react';
import {Context, Component, ReactNode} from 'react';
import PropTypes from 'prop-types';
import {Consumer} from './IdentityProvider';

const SessionContext: Context<any> = React.createContext<any>({});
const {Provider: SessionProvider} = SessionContext;

const SessionConsumer = SessionContext.Consumer as any;

class Session extends Component<{children: ReactNode}> {
    static propTypes = {
        children: PropTypes.any
    };

    render() {
        const {children} = this.props;
        return (
            <Consumer>
                {
                    ({state}: any) => {
                        const {session, authenticated} = state;
                        return (
                            <SessionProvider value={{session, authenticated}}>
                                <SessionConsumer children={children}/>
                            </SessionProvider>
                        );
                    }
                }
            </Consumer>
        );
    }
}

export default Session;
