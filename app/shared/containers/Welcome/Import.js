// @flow
import React, { Component } from 'react';
import { bindActionCreators } from 'redux';
import { find } from 'lodash';
import { Serialize } from 'eosjs2';
import { connect } from 'react-redux';
import { withRouter } from 'react-router-dom';
import compose from 'lodash/fp/compose';
import { withTranslation } from 'react-i18next';
import { Button, Form, Label, Modal, Segment } from 'semantic-ui-react';

import * as AccountsActions from '../../actions/accounts';
import * as BlockchainsActions from '../../actions/blockchains';
import * as SettingsActions from '../../actions/settings';
import * as StorageActions from '../../actions/storage';
import * as ValidateActions from '../../actions/validate';
import * as WalletActions from '../../actions/wallet';
import * as WalletsActions from '../../actions/wallets';

const defaultChainId = 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906';
import { update as update009 } from '../../store/shared/migrations/009-updateSettings';

const ecc = require('eosjs-ecc');
const bip39 = require('bip39');
const scrypt = require('scrypt-async');
const sjcl = require('sjcl');

const { ipcRenderer } = require('electron');

class WelcomeImportContainer extends Component<Props> {
  state = {
    data: undefined,
    error: undefined,
    loading: false,
    scatter: false,
    password: undefined,
  }
  handleChange = (e, { name, value }) => this.setState({ [name]: value })
  componentWillReceiveProps(nextProps) {
    const { settings, validate } = nextProps;
    if (
      settings.walletInit
      && (validate.NODE === 'SUCCESS' && this.props.validate.NODE === 'PENDING')
    ) {
      const {
        actions,
        history,
      } = this.props;
      const { account, authorization, chainId } = settings;
      if (account && authorization && chainId) {
        actions.useWallet(chainId, account, authorization);
      }
      history.push('/');
    }
  }
  handleImportAnchor = (data) => {
    const {
      actions,
    } = this.props;
    try {
      const {
        networks,
        settings,
        storage,
        wallets,
      } = JSON.parse(data);
      // Restore all defined networks
      networks.forEach((network) => {
        if (network && ['anchor.v1.network', 'anchor.v2.network'].includes(network.schema)) {
          actions.importBlockchainFromBackup(network.data);
        } else {
          // unable to import settings
          console.log(network);
        }
      });
      const chainIds = [];
      // Restore all wallets
      wallets.forEach((wallet) => {
        if (wallet && ['anchor.v1.wallet', 'anchor.v2.wallet'].includes(wallet.schema)) {
          chainIds.push(wallet.data.chainId);
          actions.importWalletFromBackup(wallet.data, settings.data);
        } else {
          // unable to import settings
        }
      });
      // Restore storage
      if (storage && ['anchor.v2.storage'].includes(storage.schema)) {
        actions.setStorage(storage.data);
      }
      // Enable all of the blockchains that wallets were imported for
      actions.setSetting('blockchains', chainIds);
      // Restore settings
      if (settings && ['anchor.v1.settings', 'anchor.v2.settings'].includes(settings.schema)) {
        const newSettings = update009(settings.data, defaultChainId);
        actions.validateNode(newSettings.node, newSettings.chainId, true, true);
        actions.setSettings(newSettings);
        actions.useWallet(newSettings.chainId, newSettings.account, newSettings.authorization);
      } else {
        // unable to import settings
        console.log(settings);
      }
    } catch (e) {
      // unable to import
      console.log('error importing', e);
    }
  }
  hashPassword = (password, salt) => new Promise(async resolve => {
    scrypt(password, salt.trim(), {
      N: 16384,
      r: 8,
      p: 1,
      dkLen: 16,
      encoding: 'hex'
    }, (derivedKey) => {
      resolve(derivedKey);
    });
  })
  passwordToSeed = async (password, salt) => {
    const hash = await this.hashPassword(password, salt);
    const mnemonic = bip39.entropyToMnemonic(hash);
    return bip39.mnemonicToSeedHex(mnemonic);
  }
  decryptWithSeed = async (seed, data) => {
    return sjcl.decrypt(seed, JSON.stringify(Object.assign(JSON.parse(data), { mode: 'gcm' })));
  }
  decryptScatter = async (password, data) => {
    // Split scatter backup into components
    const [json, , salt] = data.split('|');
    // Convert the password to a seed
    const seed = await this.passwordToSeed(password, salt);
    // Decrypt the backup with the seed
    const decryptedBackup = await this.decryptWithSeed(seed, json);
    const backup = JSON.parse(decryptedBackup);
    // Decrypt the keychain with the seed
    const decryptedKeychain = await this.decryptWithSeed(seed, backup.keychain);
    const keychain = JSON.parse(decryptedKeychain);
    return {
      ...backup,
      keychain,
      seed,
    };
  }
  handleImportScatter = async (password, data) => {
    try {
      const decrypted = await this.decryptScatter(password, data);
      const { actions } = this.props;
      const chainIds = [];
      const {
        keychain,
        seed,
        settings,
      } = decrypted;
      const {
        networks
      } = settings;
      const {
        accounts,
        keypairs,
      } = keychain;
      // Restore all defined networks
      let config = {};
      networks.forEach((network) => {
        if (network.blockchain === 'eos') {
          config = {
            _id: network.id,
            chainId: network.chainId,
            name: network.name,
            node: `${network.protocol}://${network.host}`,
            symbol: (network.token) ? network.token.symbol : undefined,
            testnet: false,
          };
          actions.importBlockchainFromBackup(config);
        }
      });
      // Restore all accounts
      accounts.forEach((account) => {
        const keypair = find(keypairs, { id: account.keypairUnique });
        // console.log(account, keypair)
        const [, , chainId] = account.networkUnique.split(':');
        const converted = {
          account: account.name,
          authority: account.authority,
          chainId,
          mode: (keypair.external) ? 'ledger' : 'hot',
          path: (keypair.external) ? `44'/194'/0'/0/${keypair.external.addressIndex}` : undefined,
          pubkey: account.publicKey,
          type: (keypair.external) ? 'ledger' : 'key',
        };
        chainIds.push(chainId);
        // commit to storage
        actions.importWalletFromBackup(converted);
      });
      // convert key storage
      const keyStore = [];
      const keys = [];
      const paths = {};
      keypairs.forEach(async (keypair) => {
        // this is a key from an external device
        if (keypair.external) {
          // Push pubkey into storage
          const pubkey = find(keypair.publicKeys, { blockchain: 'eos' }).key;
          keys.push(pubkey);
          // ensure the path exists in storage
          const path = `44'/194'/0'/0/${keypair.external.addressIndex}`;
          paths[pubkey] = path;
          // update storage
          actions.importPubkeyStorage(pubkey, path);
        } else {
          // this is just a key
          const decryptedKey = await this.decryptWithSeed(seed, keypair.privateKey);
          const privateKey = JSON.parse(decryptedKey);
          switch (privateKey.type) {
            case 'Buffer': {
              // Push pubkey into storage
              const pubkey = find(keypair.publicKeys, { blockchain: 'eos' }).key;
              keys.push(pubkey);
              // Push keypair into storage
              const key = ecc.PrivateKey.fromBuffer(Buffer.from(privateKey.data)).toString();
              keyStore.push({
                key,
                pubkey,
              });
              actions.importKeyStorage(password, key, pubkey);
              break;
            }
            default: {
              console.log('unknown format from scatter', keypair.id);
              break;
            }
          }
        }
      });
      // grab the first account as the most recent
      const [recentAccount] = accounts;
      // Initialize Anchor
      actions.setSetting('walletInit', true);
      actions.setSetting('blockchains', chainIds);
      actions.setWalletHash(password);
      actions.validateNode(config.node, config.chainId, true, true);
      actions.useWallet(recentAccount.chainId, recentAccount.name, recentAccount.authorization);
    } catch (e) {
      this.setState({
        loading: false,
        error: e,
      });
    }
  }
  unlockScatter = () => {
    const { data, password } = this.state;
    this.setState({
      error: undefined,
      loading: true,
    }, () => {
      setTimeout(() => {
        this.handleImportScatter(password, data);
      }, 250);
    });
  }
  handleImport = (event, data) => {
    let isScatter = false;
    if (data.includes('|')) {
      try {
        const [json] = data.split('|');
        const parsed = JSON.parse(json);
        if (parsed.iv && parsed.salt && parsed.ct) {
          isScatter = true;
        }
      } catch (e) {
        console.log(e);
      }
    }
    if (isScatter) {
      this.setState({ scatter: true, data });
    } else {
      this.setState({
        loading: true
      });
      this.handleImportAnchor(data);
    }
  }
  import = () => {
    const { settings } = this.props;
    ipcRenderer.send(
      'openFile',
      settings.lastFilePath
    );
    ipcRenderer.once('openFileData', this.handleImport);
  }
  render() {
    const {
      t
    } = this.props;
    const {
      error,
      loading,
      scatter,
    } = this.state;
    const incorrectPassword = "CORRUPT: gcm: tag doesn't match";
    return (
      <React.Fragment>
        <Modal
          as={Form}
          closeIcon
          onClose={() => this.setState({ data: undefined, error: undefined, scatter: false })}
          onSubmit={this.unlockScatter}
          open={scatter}
          size="small"
        >
          <Modal.Header>
            {t('welcome:welcome_import_wallets_scatter_header')}
          </Modal.Header>
          <Modal.Content>
            <Segment basic loading={loading}>
              <p>{t('welcome:welcome_import_wallets_scatter_subheader')}</p>
              <Form.Input
                autoFocus
                label={t('welcome:welcome_import_wallets_scatter_password')}
                name="password"
                onChange={this.handleChange}
                type="password"
              />
              {(error && error.toString() === incorrectPassword)
                ? (
                  <Label
                    color="red"
                    content={t('welcome:welcome_import_wallets_scatter_password_wrong')}
                  />
                )
                : false
              }
              {(error && error.toString() !== incorrectPassword)
                ? (
                  <Label
                    color="red"
                    content={error.toString()}
                  />
                )
                : false
              }
            </Segment>
          </Modal.Content>
          <Modal.Actions>
            <Button
              content={t('welcome:welcome_import_wallets_scatter')}
              disabled={loading}
              primary
            />
          </Modal.Actions>
        </Modal>
        <Button
          color="blue"
          content={t('welcome:welcome_import_wallets')}
          icon="save"
          loading={loading}
          onClick={this.import}
          size="small"
        />
      </React.Fragment>
    );
  }
}

function mapStateToProps(state) {
  return {
    connection: state.connection,
    settings: state.settings,
    validate: state.validate
  };
}

function mapDispatchToProps(dispatch) {
  return {
    actions: bindActionCreators({
      ...AccountsActions,
      ...BlockchainsActions,
      ...SettingsActions,
      ...StorageActions,
      ...ValidateActions,
      ...WalletActions,
      ...WalletsActions,
    }, dispatch)
  };
}

export default compose(
  withRouter,
  withTranslation('welcome'),
  connect(mapStateToProps, mapDispatchToProps)
)(WelcomeImportContainer);
